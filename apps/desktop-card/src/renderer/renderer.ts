type CardViewModel = {
  status: "loading" | "ready" | "unavailable" | "error";
  statusMessage: string;
  scopeLabel: string;
  alwaysOnTop: boolean;
  totalTokens: string;
  tokenMeta: string;
  cost: string;
  costMeta: string;
  toolCalls: string;
  toolMeta: string;
  edits: string;
  editMeta: string;
  successfulRuns: string;
  successfulMeta: string;
};

type CardBridge = {
  onState(listener: (state: CardViewModel) => void): () => void;
  refresh(): Promise<CardViewModel | void>;
  close(): Promise<unknown>;
};

declare global {
  interface Window {
    agentMetricsCard?: CardBridge;
  }
}

const card = document.querySelector(".card") as HTMLElement;
const refreshButton = document.getElementById("refresh-button") as HTMLButtonElement;
const closeButton = document.getElementById("close-button") as HTMLButtonElement;

const fields = {
  scope: document.getElementById("scope-label") as HTMLElement,
  totalTokens: document.getElementById("total-tokens") as HTMLElement,
  tokenMeta: document.getElementById("token-meta") as HTMLElement,
  cost: document.getElementById("cost") as HTMLElement,
  costMeta: document.getElementById("cost-meta") as HTMLElement,
  toolCalls: document.getElementById("tool-calls") as HTMLElement,
  toolMeta: document.getElementById("tool-meta") as HTMLElement,
  edits: document.getElementById("edits") as HTMLElement,
  editMeta: document.getElementById("edit-meta") as HTMLElement,
  successfulRuns: document.getElementById("successful-runs") as HTMLElement,
  successfulMeta: document.getElementById("successful-meta") as HTMLElement
};

function text(node: HTMLElement, value: string): void {
  if (node.textContent !== value) {
    node.textContent = value;
  }
}

function render(view: CardViewModel): void {
  card.dataset.status = view.status;
  card.dataset.pinned = view.alwaysOnTop ? "true" : "false";
  text(fields.scope, view.scopeLabel);
  text(fields.totalTokens, view.totalTokens);
  text(fields.tokenMeta, view.status === "ready" ? view.tokenMeta : view.statusMessage || view.tokenMeta);
  text(fields.cost, view.cost);
  text(fields.costMeta, view.costMeta);
  text(fields.toolCalls, view.toolCalls);
  text(fields.toolMeta, view.toolMeta);
  text(fields.edits, view.edits);
  text(fields.editMeta, view.editMeta);
  text(fields.successfulRuns, view.successfulRuns);
  text(fields.successfulMeta, view.successfulMeta);
}

const bridge = window.agentMetricsCard;
const unsubscribe = bridge?.onState((state) => {
  render(state);
});

refreshButton.addEventListener("click", () => {
  void bridge?.refresh();
});
closeButton.addEventListener("click", () => {
  void bridge?.close();
});

window.addEventListener("beforeunload", () => {
  unsubscribe?.();
});

export {};
