import Renamer from "./lib/renamer";
import type NodePath from "../path";
import traverse from "../index";
import type { TraverseOptions } from "../index";
import Binding from "./binding";
import type { BindingKind } from "./binding";
import globals from "globals";
import {
  NOT_LOCAL_BINDING,
  callExpression,
  cloneNode,
  getBindingIdentifiers,
  identifier,
  isArrayExpression,
  isBinary,
  isClass,
  isClassBody,
  isClassDeclaration,
  isExportAllDeclaration,
  isExportDefaultDeclaration,
  isExportNamedDeclaration,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isLiteral,
  isMethod,
  isModuleDeclaration,
  isModuleSpecifier,
  isObjectExpression,
  isProperty,
  isPureish,
  isSuper,
  isTaggedTemplateExpression,
  isTemplateLiteral,
  isThisExpression,
  isUnaryExpression,
  isVariableDeclaration,
  matchesPattern,
  memberExpression,
  numericLiteral,
  toIdentifier,
  unaryExpression,
  variableDeclaration,
  variableDeclarator,
} from "@babel/types";
import type * as t from "@babel/types";
import { scope as scopeCache } from "../cache";
import type { Visitor } from "../types";

// Recursively gathers the identifying names of a node.
function gatherNodeParts(node: t.Node, parts: any[]) {
  switch (node?.type) {
    default:
      if (isModuleDeclaration(node)) {
        if (
          (isExportAllDeclaration(node) ||
            isExportNamedDeclaration(node) ||
            isImportDeclaration(node)) &&
          node.source
        ) {
          gatherNodeParts(node.source, parts);
        } else if (
          (isExportNamedDeclaration(node) || isImportDeclaration(node)) &&
          node.specifiers &&
          node.specifiers.length
        ) {
          for (const e of node.specifiers) gatherNodeParts(e, parts);
        } else if (
          (isExportDefaultDeclaration(node) ||
            isExportNamedDeclaration(node)) &&
          node.declaration
        ) {
          gatherNodeParts(node.declaration, parts);
        }
      } else if (isModuleSpecifier(node)) {
        // todo(flow->ts): should condition instead be:
        //    ```
        //    t.isExportSpecifier(node) ||
        //    t.isImportDefaultSpecifier(node) ||
        //    t.isImportNamespaceSpecifier(node) ||
        //    t.isImportSpecifier(node)
        //    ```
        //    allowing only nodes with `.local`?
        // @ts-expect-error todo(flow->ts)
        gatherNodeParts(node.local, parts);
      } else if (isLiteral(node)) {
        // todo(flow->ts): should condition be stricter to ensure value is there
        //   ```
        //   !t.isNullLiteral(node) &&
        //   !t.isRegExpLiteral(node) &&
        //   !isTemplateLiteral(node)
        //   ```
        // @ts-expect-error todo(flow->ts)
        parts.push(node.value);
      }
      break;

    case "MemberExpression":
    case "OptionalMemberExpression":
    case "JSXMemberExpression":
      gatherNodeParts(node.object, parts);
      gatherNodeParts(node.property, parts);
      break;

    case "Identifier":
    case "JSXIdentifier":
      parts.push(node.name);
      break;

    case "CallExpression":
    case "OptionalCallExpression":
    case "NewExpression":
      gatherNodeParts(node.callee, parts);
      break;

    case "ObjectExpression":
    case "ObjectPattern":
      for (const e of node.properties) {
        gatherNodeParts(e, parts);
      }
      break;

    case "SpreadElement":
    case "RestElement":
      gatherNodeParts(node.argument, parts);
      break;

    case "ObjectProperty":
    case "ObjectMethod":
    case "ClassProperty":
    case "ClassMethod":
    case "ClassPrivateProperty":
    case "ClassPrivateMethod":
      gatherNodeParts(node.key, parts);
      break;

    case "ThisExpression":
      parts.push("this");
      break;

    case "Super":
      parts.push("super");
      break;

    case "Import":
      parts.push("import");
      break;

    case "DoExpression":
      parts.push("do");
      break;

    case "YieldExpression":
      parts.push("yield");
      gatherNodeParts(node.argument, parts);
      break;

    case "AwaitExpression":
      parts.push("await");
      gatherNodeParts(node.argument, parts);
      break;

    case "AssignmentExpression":
      gatherNodeParts(node.left, parts);
      break;

    case "VariableDeclarator":
      gatherNodeParts(node.id, parts);
      break;

    case "FunctionExpression":
    case "FunctionDeclaration":
    case "ClassExpression":
    case "ClassDeclaration":
      gatherNodeParts(node.id, parts);
      break;

    case "PrivateName":
      gatherNodeParts(node.id, parts);
      break;

    case "ParenthesizedExpression":
      gatherNodeParts(node.expression, parts);
      break;

    case "UnaryExpression":
    case "UpdateExpression":
      gatherNodeParts(node.argument, parts);
      break;

    case "MetaProperty":
      gatherNodeParts(node.meta, parts);
      gatherNodeParts(node.property, parts);
      break;

    case "JSXElement":
      gatherNodeParts(node.openingElement, parts);
      break;

    case "JSXOpeningElement":
      parts.push(node.name);
      break;

    case "JSXFragment":
      gatherNodeParts(node.openingFragment, parts);
      break;

    case "JSXOpeningFragment":
      parts.push("Fragment");
      break;

    case "JSXNamespacedName":
      gatherNodeParts(node.namespace, parts);
      gatherNodeParts(node.name, parts);
      break;
  }
}

//
interface CollectVisitorState {
  assignments: NodePath<t.AssignmentExpression>[];
  references: NodePath<t.Identifier | t.JSXIdentifier>[];
  constantViolations: NodePath[];
}

const collectorVisitor: Visitor<CollectVisitorState> = {
  ForStatement(path) {
    const declar = path.get("init");
    // delegate block scope handling to the `BlockScoped` method
    if (declar.isVar()) {
      const { scope } = path;
      const parentScope = scope.getFunctionParent() || scope.getProgramParent();
      parentScope.registerBinding("var", declar);
    }
  },

  Declaration(path) {
    // delegate block scope handling to the `BlockScoped` method
    if (path.isBlockScoped()) return;

    // delegate import handing to the `ImportDeclaration` method
    if (path.isImportDeclaration()) return;

    // this will be hit again once we traverse into it after this iteration
    if (path.isExportDeclaration()) return;

    // we've ran into a declaration!
    const parent =
      path.scope.getFunctionParent() || path.scope.getProgramParent();
    parent.registerDeclaration(path);
  },

  ImportDeclaration(path) {
    // import may only appear in the top level or inside a module/namespace (for TS/flow)
    const parent = path.scope.getBlockParent();

    parent.registerDeclaration(path);
  },

  ReferencedIdentifier(path, state) {
    state.references.push(path);
  },

  ForXStatement(path, state) {
    const left = path.get("left");
    if (left.isPattern() || left.isIdentifier()) {
      state.constantViolations.push(path);
    }
    // delegate block scope handling to the `BlockScoped` method
    else if (left.isVar()) {
      const { scope } = path;
      const parentScope = scope.getFunctionParent() || scope.getProgramParent();
      parentScope.registerBinding("var", left);
    }
  },

  ExportDeclaration: {
    exit(path) {
      const { node, scope } = path;
      // ExportAllDeclaration does not have `declaration`
      if (isExportAllDeclaration(node)) return;
      const declar = node.declaration;
      if (isClassDeclaration(declar) || isFunctionDeclaration(declar)) {
        const id = declar.id;
        if (!id) return;

        const binding = scope.getBinding(id.name);
        binding?.reference(path);
      } else if (isVariableDeclaration(declar)) {
        for (const decl of declar.declarations) {
          for (const name of Object.keys(getBindingIdentifiers(decl))) {
            const binding = scope.getBinding(name);
            binding?.reference(path);
          }
        }
      }
    },
  },

  LabeledStatement(path) {
    path.scope.getBlockParent().registerDeclaration(path);
  },

  AssignmentExpression(path, state) {
    state.assignments.push(path);
  },

  UpdateExpression(path, state) {
    state.constantViolations.push(path);
  },

  UnaryExpression(path, state) {
    if (path.node.operator === "delete") {
      state.constantViolations.push(path);
    }
  },

  BlockScoped(path) {
    let scope = path.scope;
    if (scope.path === path) scope = scope.parent;

    const parent = scope.getBlockParent();
    parent.registerDeclaration(path);

    // Register class identifier in class' scope if this is a class declaration.
    if (path.isClassDeclaration() && path.node.id) {
      const id = path.node.id;
      const name = id.name;

      path.scope.bindings[name] = path.scope.parent.getBinding(name);
    }
  },

  CatchClause(path) {
    path.scope.registerBinding("let", path);
  },

  Function(path) {
    const params: Array<NodePath> = path.get("params");
    for (const param of params) {
      path.scope.registerBinding("param", param);
    }

    // Register function expression id after params. When the id
    // collides with a function param, the id effectively can't be
    // referenced: here we registered it as a constantViolation
    if (
      path.isFunctionExpression() &&
      path.has("id") &&
      !path.get("id").node[NOT_LOCAL_BINDING]
    ) {
      path.scope.registerBinding("local", path.get("id"), path);
    }
  },

  ClassExpression(path) {
    if (path.has("id") && !path.get("id").node[NOT_LOCAL_BINDING]) {
      path.scope.registerBinding("local", path);
    }
  },
};

let uid = 0;

export type { Binding };

export default class Scope {
  uid;

  path: NodePath;
  block: t.Node;

  labels;
  inited;

  bindings: { [name: string]: Binding };
  references: object;
  globals: object;
  uids: object;
  data: object;
  crawling: boolean;

  /**
   * This searches the current "scope" and collects all references/bindings
   * within.
   */
  constructor(path: NodePath) {
    const { node } = path;
    const cached = scopeCache.get(node);
    // Sometimes, a scopable path is placed higher in the AST tree.
    // In these cases, have to create a new Scope.
    if (cached?.path === path) {
      return cached;
    }
    scopeCache.set(node, this);

    this.uid = uid++;

    this.block = node;
    this.path = path;

    this.labels = new Map();
    this.inited = false;
  }

  /**
   * Globals.
   */

  static globals = Object.keys(globals.builtin);

  /**
   * Variables available in current context.
   */

  static contextVariables = ["arguments", "undefined", "Infinity", "NaN"];

  get parent() {
    let parent,
      path = this.path;
    do {
      // Skip method scope if coming from inside computed key
      const isKey = path.key === "key";
      path = path.parentPath;
      if (isKey && path.isMethod()) path = path.parentPath;
      if (path && path.isScope()) parent = path;
    } while (path && !parent);

    return parent?.scope;
  }

  get parentBlock() {
    return this.path.parent;
  }

  get hub() {
    return this.path.hub;
  }

  traverse<S>(
    node: t.Node | t.Node[],
    opts: TraverseOptions<S>,
    state: S,
  ): void;
  traverse(node: t.Node | t.Node[], opts?: TraverseOptions, state?: any): void;
  /**
   * Traverse node with current scope and path.
   */
  traverse(node: any, opts: any, state?) {
    traverse(node, opts, this, state, this.path);
  }

  /**
   * Generate a unique identifier and add it to the current scope.
   */

  generateDeclaredUidIdentifier(name?: string) {
    const id = this.generateUidIdentifier(name);
    this.push({ id });
    return cloneNode(id);
  }

  /**
   * Generate a unique identifier.
   */

  generateUidIdentifier(name?: string) {
    return identifier(this.generateUid(name));
  }

  /**
   * Generate a unique `_id1` binding.
   */

  generateUid(name: string = "temp"): string {
    name = toIdentifier(name)
      .replace(/^_+/, "")
      .replace(/[0-9]+$/g, "");

    let uid;
    let i = 1;
    do {
      uid = this._generateUid(name, i);
      i++;
    } while (
      this.hasLabel(uid) ||
      this.hasBinding(uid) ||
      this.hasGlobal(uid) ||
      this.hasReference(uid)
    );

    const program = this.getProgramParent();
    program.references[uid] = true;
    program.uids[uid] = true;

    return uid;
  }

  /**
   * Generate an `_id1`.
   */

  _generateUid(name, i) {
    let id = name;
    if (i > 1) id += i;
    return `_${id}`;
  }

  generateUidBasedOnNode(node: t.Node, defaultName?: string) {
    const parts = [];
    gatherNodeParts(node, parts);

    let id = parts.join("$");
    id = id.replace(/^_/, "") || defaultName || "ref";

    return this.generateUid(id.slice(0, 20));
  }

  /**
   * Generate a unique identifier based on a node.
   */

  generateUidIdentifierBasedOnNode(node: t.Node, defaultName?: string) {
    return identifier(this.generateUidBasedOnNode(node, defaultName));
  }

  /**
   * Determine whether evaluating the specific input `node` is a consequenceless reference. ie.
   * evaluating it wont result in potentially arbitrary code from being ran. The following are
   * allowed and determined not to cause side effects:
   *
   *  - `this` expressions
   *  - `super` expressions
   *  - Bound identifiers
   */

  isStatic(node: t.Node): boolean {
    if (isThisExpression(node) || isSuper(node)) {
      return true;
    }

    if (isIdentifier(node)) {
      const binding = this.getBinding(node.name);
      if (binding) {
        return binding.constant;
      } else {
        return this.hasBinding(node.name);
      }
    }

    return false;
  }

  /**
   * Possibly generate a memoised identifier if it is not static and has consequences.
   */

  maybeGenerateMemoised(node: t.Node, dontPush?: boolean) {
    if (this.isStatic(node)) {
      return null;
    } else {
      const id = this.generateUidIdentifierBasedOnNode(node);
      if (!dontPush) {
        this.push({ id });
        return cloneNode(id);
      }
      return id;
    }
  }

  checkBlockScopedCollisions(
    local: Binding,
    kind: BindingKind,
    name: string,
    id: any,
  ) {
    // ignore parameters
    if (kind === "param") return;

    // Ignore existing binding if it's the name of the current function or
    // class expression
    if (local.kind === "local") return;

    const duplicate =
      // don't allow duplicate bindings to exist alongside
      kind === "let" ||
      local.kind === "let" ||
      local.kind === "const" ||
      local.kind === "module" ||
      // don't allow a local of param with a kind of let
      (local.kind === "param" && kind === "const");

    if (duplicate) {
      throw this.hub.buildError(
        id,
        `Duplicate declaration "${name}"`,
        TypeError,
      );
    }
  }

  rename(oldName: string, newName?: string, block?: t.Node) {
    const binding = this.getBinding(oldName);
    if (binding) {
      newName = newName || this.generateUidIdentifier(oldName).name;
      return new Renamer(binding, oldName, newName).rename(block);
    }
  }

  _renameFromMap(map, oldName, newName, value) {
    if (map[oldName]) {
      map[newName] = value;
      map[oldName] = null;
    }
  }

  dump() {
    const sep = "-".repeat(60);
    console.log(sep);
    let scope: Scope = this;
    do {
      console.log("#", scope.block.type);
      for (const name of Object.keys(scope.bindings)) {
        const binding = scope.bindings[name];
        console.log(" -", name, {
          constant: binding.constant,
          references: binding.references,
          violations: binding.constantViolations.length,
          kind: binding.kind,
        });
      }
    } while ((scope = scope.parent));
    console.log(sep);
  }

  // TODO: (Babel 8) Split i in two parameters, and use an object of flags
  toArray(node: t.Node, i?: number | boolean, arrayLikeIsIterable?: boolean) {
    if (isIdentifier(node)) {
      const binding = this.getBinding(node.name);
      if (binding?.constant && binding.path.isGenericType("Array")) {
        return node;
      }
    }

    if (isArrayExpression(node)) {
      return node;
    }

    if (isIdentifier(node, { name: "arguments" })) {
      return callExpression(
        memberExpression(
          memberExpression(
            memberExpression(identifier("Array"), identifier("prototype")),
            identifier("slice"),
          ),
          identifier("call"),
        ),
        [node],
      );
    }

    let helperName;
    const args = [node];
    if (i === true) {
      // Used in array-spread to create an array.
      helperName = "toConsumableArray";
    } else if (i) {
      args.push(numericLiteral(i));

      // Used in array-rest to create an array from a subset of an iterable.
      helperName = "slicedToArray";
      // TODO if (this.hub.isLoose("es6.forOf")) helperName += "-loose";
    } else {
      // Used in array-rest to create an array
      helperName = "toArray";
    }

    if (arrayLikeIsIterable) {
      args.unshift(this.hub.addHelper(helperName));
      helperName = "maybeArrayLike";
    }

    // @ts-expect-error todo(flow->ts): t.Node is not valid to use in args, function argument typeneeds to be clarified
    return callExpression(this.hub.addHelper(helperName), args);
  }

  hasLabel(name: string) {
    return !!this.getLabel(name);
  }

  getLabel(name: string) {
    return this.labels.get(name);
  }

  registerLabel(path: NodePath<t.LabeledStatement>) {
    this.labels.set(path.node.label.name, path);
  }

  registerDeclaration(path: NodePath) {
    if (path.isLabeledStatement()) {
      this.registerLabel(path);
    } else if (path.isFunctionDeclaration()) {
      this.registerBinding("hoisted", path.get("id"), path);
    } else if (path.isVariableDeclaration()) {
      const declarations = path.get("declarations");
      for (const declar of declarations) {
        this.registerBinding(path.node.kind, declar);
      }
    } else if (path.isClassDeclaration()) {
      if (path.node.declare) return;
      this.registerBinding("let", path);
    } else if (path.isImportDeclaration()) {
      const specifiers = path.get("specifiers");
      for (const specifier of specifiers) {
        this.registerBinding("module", specifier);
      }
    } else if (path.isExportDeclaration()) {
      // todo: improve babel-types
      const declar = path.get("declaration") as NodePath;
      if (
        declar.isClassDeclaration() ||
        declar.isFunctionDeclaration() ||
        declar.isVariableDeclaration()
      ) {
        this.registerDeclaration(declar);
      }
    } else {
      this.registerBinding("unknown", path);
    }
  }

  buildUndefinedNode() {
    return unaryExpression("void", numericLiteral(0), true);
  }

  registerConstantViolation(path: NodePath) {
    const ids = path.getBindingIdentifiers();
    for (const name of Object.keys(ids)) {
      const binding = this.getBinding(name);
      if (binding) binding.reassign(path);
    }
  }

  registerBinding(
    kind: Binding["kind"],
    path: NodePath,
    bindingPath: NodePath = path,
  ) {
    if (!kind) throw new ReferenceError("no `kind`");

    if (path.isVariableDeclaration()) {
      const declarators: Array<NodePath> = path.get("declarations");
      for (const declar of declarators) {
        this.registerBinding(kind, declar);
      }
      return;
    }

    const parent = this.getProgramParent();
    const ids = path.getOuterBindingIdentifiers(true);

    for (const name of Object.keys(ids)) {
      parent.references[name] = true;

      for (const id of ids[name]) {
        const local = this.getOwnBinding(name);

        if (local) {
          // same identifier so continue safely as we're likely trying to register it
          // multiple times
          if (local.identifier === id) continue;

          this.checkBlockScopedCollisions(local, kind, name, id);
        }

        // A redeclaration of an existing variable is a modification
        if (local) {
          this.registerConstantViolation(bindingPath);
        } else {
          this.bindings[name] = new Binding({
            identifier: id,
            scope: this,
            path: bindingPath,
            kind: kind,
          });
        }
      }
    }
  }

  // todo: flow->ts maybe add more specific type
  addGlobal(node: Extract<t.Node, { name: string }>) {
    this.globals[node.name] = node;
  }

  hasUid(name: string): boolean {
    let scope: Scope = this;

    do {
      if (scope.uids[name]) return true;
    } while ((scope = scope.parent));

    return false;
  }

  hasGlobal(name: string): boolean {
    let scope: Scope = this;

    do {
      if (scope.globals[name]) return true;
    } while ((scope = scope.parent));

    return false;
  }

  hasReference(name: string): boolean {
    return !!this.getProgramParent().references[name];
  }

  isPure(node: t.Node, constantsOnly?: boolean) {
    if (isIdentifier(node)) {
      const binding = this.getBinding(node.name);
      if (!binding) return false;
      if (constantsOnly) return binding.constant;
      return true;
    } else if (isClass(node)) {
      if (node.superClass && !this.isPure(node.superClass, constantsOnly)) {
        return false;
      }
      return this.isPure(node.body, constantsOnly);
    } else if (isClassBody(node)) {
      for (const method of node.body) {
        if (!this.isPure(method, constantsOnly)) return false;
      }
      return true;
    } else if (isBinary(node)) {
      return (
        this.isPure(node.left, constantsOnly) &&
        this.isPure(node.right, constantsOnly)
      );
    } else if (isArrayExpression(node)) {
      for (const elem of node.elements) {
        if (!this.isPure(elem, constantsOnly)) return false;
      }
      return true;
    } else if (isObjectExpression(node)) {
      for (const prop of node.properties) {
        if (!this.isPure(prop, constantsOnly)) return false;
      }
      return true;
    } else if (isMethod(node)) {
      if (node.computed && !this.isPure(node.key, constantsOnly)) return false;
      if (node.kind === "get" || node.kind === "set") return false;
      return true;
    } else if (isProperty(node)) {
      // @ts-expect-error todo(flow->ts): computed in not present on private properties
      if (node.computed && !this.isPure(node.key, constantsOnly)) return false;
      return this.isPure(node.value, constantsOnly);
    } else if (isUnaryExpression(node)) {
      return this.isPure(node.argument, constantsOnly);
    } else if (isTaggedTemplateExpression(node)) {
      return (
        matchesPattern(node.tag, "String.raw") &&
        !this.hasBinding("String", true) &&
        this.isPure(node.quasi, constantsOnly)
      );
    } else if (isTemplateLiteral(node)) {
      for (const expression of node.expressions) {
        if (!this.isPure(expression, constantsOnly)) return false;
      }
      return true;
    } else {
      return isPureish(node);
    }
  }

  /**
   * Set some arbitrary data on the current scope.
   */

  setData(key: string | symbol, val: any) {
    return (this.data[key] = val);
  }

  /**
   * Recursively walk up scope tree looking for the data `key`.
   */

  getData(key: string | symbol): any {
    let scope: Scope = this;
    do {
      const data = scope.data[key];
      if (data != null) return data;
    } while ((scope = scope.parent));
  }

  /**
   * Recursively walk up scope tree looking for the data `key` and if it exists,
   * remove it.
   */

  removeData(key: string) {
    let scope: Scope = this;
    do {
      const data = scope.data[key];
      if (data != null) scope.data[key] = null;
    } while ((scope = scope.parent));
  }

  init() {
    if (!this.inited) {
      this.inited = true;
      this.crawl();
    }
  }

  crawl() {
    const path = this.path;

    this.references = Object.create(null);
    this.bindings = Object.create(null);
    this.globals = Object.create(null);
    this.uids = Object.create(null);
    this.data = Object.create(null);

    const programParent = this.getProgramParent();
    if (programParent.crawling) return;

    const state: CollectVisitorState = {
      references: [],
      constantViolations: [],
      assignments: [],
    };

    this.crawling = true;
    // traverse does not visit the root node, here we explicitly collect
    // root node binding info when the root is not a Program.
    if (path.type !== "Program" && collectorVisitor._exploded) {
      // @ts-expect-error when collectorVisitor is exploded, `enter` always exists
      for (const visit of collectorVisitor.enter) {
        visit(path, state);
      }
      const typeVisitors = collectorVisitor[path.type];
      if (typeVisitors) {
        // @ts-expect-error when collectorVisitor is exploded, `enter` always exists
        for (const visit of typeVisitors.enter) {
          visit(path, state);
        }
      }
    }
    path.traverse(collectorVisitor, state);
    this.crawling = false;

    // register assignments
    for (const path of state.assignments) {
      // register undeclared bindings as globals
      const ids = path.getBindingIdentifiers();
      for (const name of Object.keys(ids)) {
        if (path.scope.getBinding(name)) continue;
        programParent.addGlobal(ids[name]);
      }

      // register as constant violation
      path.scope.registerConstantViolation(path);
    }

    // register references
    for (const ref of state.references) {
      const binding = ref.scope.getBinding(ref.node.name);
      if (binding) {
        binding.reference(ref);
      } else {
        programParent.addGlobal(ref.node);
      }
    }

    // register constant violations
    for (const path of state.constantViolations) {
      path.scope.registerConstantViolation(path);
    }
  }

  push(opts: {
    id: t.LVal;
    init?: t.Expression;
    unique?: boolean;
    _blockHoist?: number | undefined;
    kind?: "var" | "let" | "const";
  }) {
    let path = this.path;

    if (!path.isBlockStatement() && !path.isProgram()) {
      path = this.getBlockParent().path;
    }

    if (path.isSwitchStatement()) {
      path = (this.getFunctionParent() || this.getProgramParent()).path;
    }

    if (path.isLoop() || path.isCatchClause() || path.isFunction()) {
      path.ensureBlock();
      // @ts-expect-error todo(flow->ts): improve types
      path = path.get("body");
    }

    const unique = opts.unique;
    const kind = opts.kind || "var";
    const blockHoist = opts._blockHoist == null ? 2 : opts._blockHoist;

    const dataKey = `declaration:${kind}:${blockHoist}`;
    let declarPath = !unique && path.getData(dataKey);

    if (!declarPath) {
      const declar = variableDeclaration(kind, []);
      // @ts-expect-error todo(flow->ts): avoid modifying nodes
      declar._blockHoist = blockHoist;

      [declarPath] = path.unshiftContainer("body", [declar]);
      if (!unique) path.setData(dataKey, declarPath);
    }

    const declarator = variableDeclarator(opts.id, opts.init);
    const len = declarPath.node.declarations.push(declarator);
    path.scope.registerBinding(kind, declarPath.get("declarations")[len - 1]);
  }

  /**
   * Walk up to the top of the scope tree and get the `Program`.
   */

  getProgramParent() {
    let scope: Scope = this;
    do {
      if (scope.path.isProgram()) {
        return scope;
      }
    } while ((scope = scope.parent));
    throw new Error("Couldn't find a Program");
  }

  /**
   * Walk up the scope tree until we hit either a Function or return null.
   */

  getFunctionParent(): Scope | null {
    let scope: Scope = this;
    do {
      if (scope.path.isFunctionParent()) {
        return scope;
      }
    } while ((scope = scope.parent));
    return null;
  }

  /**
   * Walk up the scope tree until we hit either a BlockStatement/Loop/Program/Function/Switch or reach the
   * very top and hit Program.
   */

  getBlockParent() {
    let scope: Scope = this;
    do {
      if (scope.path.isBlockParent()) {
        return scope;
      }
    } while ((scope = scope.parent));
    throw new Error(
      "We couldn't find a BlockStatement, For, Switch, Function, Loop or Program...",
    );
  }

  /**
   * Walks the scope tree and gathers **all** bindings.
   */

  getAllBindings(): Record<string, Binding> {
    const ids = Object.create(null);

    let scope: Scope = this;
    do {
      for (const key of Object.keys(scope.bindings)) {
        if (key in ids === false) {
          ids[key] = scope.bindings[key];
        }
      }
      scope = scope.parent;
    } while (scope);

    return ids;
  }

  /**
   * Walks the scope tree and gathers all declarations of `kind`.
   */

  getAllBindingsOfKind(...kinds: string[]): Record<string, Binding> {
    const ids = Object.create(null);

    for (const kind of kinds) {
      let scope: Scope = this;
      do {
        for (const name of Object.keys(scope.bindings)) {
          const binding = scope.bindings[name];
          if (binding.kind === kind) ids[name] = binding;
        }
        scope = scope.parent;
      } while (scope);
    }

    return ids;
  }

  bindingIdentifierEquals(name: string, node: t.Node): boolean {
    return this.getBindingIdentifier(name) === node;
  }

  getBinding(name: string): Binding | undefined {
    let scope: Scope = this;
    let previousPath;

    do {
      const binding = scope.getOwnBinding(name);
      if (binding) {
        // Check if a pattern is a part of parameter expressions.
        // Note: for performance reason we skip checking previousPath.parentPath.isFunction()
        // because `scope.path` is validated as scope in packages/babel-types/src/validators/isScope.js
        // That is, if a scope path is pattern, its parent must be Function/CatchClause

        // Spec 9.2.10.28: The closure created by this expression should not have visibility of
        // declarations in the function body. If the binding is not a `param`-kind (as function parameters)
        // or `local`-kind (as id in function expression),
        // then it must be defined inside the function body, thus it should be skipped
        if (
          previousPath?.isPattern() &&
          binding.kind !== "param" &&
          binding.kind !== "local"
        ) {
          // do nothing
        } else {
          return binding;
        }
      } else if (
        !binding &&
        name === "arguments" &&
        scope.path.isFunction() &&
        !scope.path.isArrowFunctionExpression()
      ) {
        break;
      }
      previousPath = scope.path;
    } while ((scope = scope.parent));
  }

  getOwnBinding(name: string): Binding | undefined {
    return this.bindings[name];
  }

  // todo: return probably can be undefined…
  getBindingIdentifier(name: string): t.Identifier {
    return this.getBinding(name)?.identifier;
  }

  // todo: flow->ts return probably can be undefined
  getOwnBindingIdentifier(name: string): t.Identifier {
    const binding = this.bindings[name];
    return binding?.identifier;
  }

  hasOwnBinding(name: string) {
    return !!this.getOwnBinding(name);
  }

  hasBinding(name: string, noGlobals?) {
    if (!name) return false;
    if (this.hasOwnBinding(name)) return true;
    if (this.parentHasBinding(name, noGlobals)) return true;
    if (this.hasUid(name)) return true;
    if (!noGlobals && Scope.globals.includes(name)) return true;
    if (!noGlobals && Scope.contextVariables.includes(name)) return true;
    return false;
  }

  parentHasBinding(name: string, noGlobals?) {
    return this.parent?.hasBinding(name, noGlobals);
  }

  /**
   * Move a binding of `name` to another `scope`.
   */

  moveBindingTo(name: string, scope: Scope) {
    const info = this.getBinding(name);
    if (info) {
      info.scope.removeOwnBinding(name);
      info.scope = scope;
      scope.bindings[name] = info;
    }
  }

  removeOwnBinding(name: string) {
    delete this.bindings[name];
  }

  removeBinding(name: string) {
    // clear literal binding
    this.getBinding(name)?.scope.removeOwnBinding(name);

    // clear uids with this name - https://github.com/babel/babel/issues/2101
    let scope: Scope = this;
    do {
      if (scope.uids[name]) {
        scope.uids[name] = false;
      }
    } while ((scope = scope.parent));
  }
}
