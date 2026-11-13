/** Intentionally small DOM: enough node identity/movement to test the real module graph. */
export class StubElement {
  readonly dataset: Record<string, string> = {};
  readonly style = { height: "" };
  readonly classList = { toggle: (_name: string, _force?: boolean): void => {} };
  readonly nodes: StubElement[] = [];
  readonly listeners = new Map<string, unknown>();
  readonly controls = new Map<string, StubElement>();
  parent: StubElement | null = null;
  hidden = false;
  readonly attributes = new Map<string, string>();
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  value = "";
  disabled = false;
  textContent: string | null = "";
  className = "";
  scrollTop = 0;
  scrollHeight = 100;
  clientHeight = 100;
  writes = 0;
  focused = false;
  #html = "";
  get innerHTML(): string {
    return this.#html;
  }
  set innerHTML(value: string) {
    this.#html = value;
    this.writes++;
    for (const child of this.nodes) child.parent = null;
    this.nodes.length = 0;
  }
  get children(): { item: (index: number) => StubElement | null } {
    return { item: (index) => this.nodes[index] ?? null };
  }
  insertBefore(node: StubElement, before: StubElement | null): StubElement {
    node.remove();
    const index = before === null ? this.nodes.length : this.nodes.indexOf(before);
    if (index < 0) throw new Error("Missing reference node");
    this.nodes.splice(index, 0, node);
    node.parent = this;
    return node;
  }
  remove(): void {
    if (this.parent) {
      const index = this.parent.nodes.indexOf(this);
      if (index >= 0) this.parent.nodes.splice(index, 1);
    }
    this.parent = null;
  }
  focus(): void {
    this.focused = true;
  }
  addEventListener(type: string, listener: unknown): void {
    this.listeners.set(type, listener);
  }
  trigger(type: string, event: unknown): void {
    const listener = this.listeners.get(type);
    if (typeof listener === "function") Reflect.apply(listener, this, [event]);
  }
  closest(selector: string): StubElement | null {
    if (selector === "button[data-action]" && this.dataset["action"]) return this;
    if (selector === ".archive-card") return this.parent;
    return null;
  }
  querySelector(selector: string): StubElement | null {
    return this.controls.get(selector) ?? null;
  }
}
class StubInput extends StubElement {}
class StubTextarea extends StubElement {}
class StubButton extends StubElement {}
class StubSelect extends StubElement {}

export function installDom(): {
  readonly elements: Map<string, StubElement>;
  readonly restore: () => void;
} {
  const elements = new Map<string, StubElement>();
  for (const id of [
    "view-chat",
    "view-memory",
    "view-agenda",
    "view-search",
    "view-tools",
    "workspace-title",
    "chat-messages",
    "chat-status",
    "buckets",
    "agenda",
    "detail",
    "selected-bucket-label",
    "memory-query-result",
    "task-list",
    "agent-list",
    "agent-status",
    "work-items",
    "work-item-form",
  ]) {
    elements.set(id, new StubElement());
  }
  for (const id of [
    "nav-chat",
    "nav-memory",
    "nav-agenda",
    "nav-search",
    "nav-tools",
    "chat-send",
    "memory-query-button",
    "new-chat",
    "refresh-buckets",
    "refresh-agenda",
    "task-refresh",
    "agent-propose",
    "agent-register",
    "agent-refresh",
  ]) {
    elements.set(id, new StubButton());
  }
  for (const id of ["agent-backend", "agent-workspace"]) elements.set(id, new StubSelect());
  for (const id of ["agent-path", "agent-bucket", "agent-session"])
    elements.set(id, new StubInput());
  elements.set("agent-instruction", new StubTextarea());
  elements.set("chat-input", new StubTextarea());
  elements.set("memory-query", new StubInput());
  const globals = {
    Element: StubElement,
    HTMLElement: StubElement,
    HTMLInputElement: StubInput,
    HTMLTextAreaElement: StubTextarea,
    HTMLButtonElement: StubButton,
    HTMLSelectElement: StubSelect,
    document: {
      querySelector: (selector: string) => elements.get(selector.slice(1)) ?? null,
      querySelectorAll: () => [],
      createElement: () => new StubElement(),
    },
  };
  const descriptors = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  Object.assign(globalThis, globals);
  return {
    elements,
    restore: () => {
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}
