/**
 * 🐉 Dragon Code — Application complète en un seul fichier TypeScript
 * ============================================================
 * Serveur HTTP + SQLite + NVIDIA NIM streaming + Interface web
 * Lance avec : bun run dragon-code.ts
 * Ouvre : http://localhost:3000
 *
 * Tout est dans ce fichier :
 *  - Serveur HTTP (Hono)
 *  - Base de données SQLite (bun:sqlite)
 *  - Client NVIDIA NIM (streaming SSE)
 *  - Templates HTML
 *  - CSS (thème sombre vert)
 *  - JavaScript frontend
 */

import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";

// ============================================================
// CONFIGURATION
// ============================================================

const NIM_URL = "https://integrate.api.nvidia.com/v1/chat/completions";

for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
  if (process.env[key]?.includes("127.0.0.1:9")) delete process.env[key];
}

const NIM_MODELS = [
  { key: "qwen3.5-397b", name: "Qwen 3.5 397B", apiId: "qwen/qwen3.5-397b-a17b" },
  { key: "minimax-m3", name: "MiniMax M3", apiId: "minimaxai/minimax-m3" },
  { key: "mistral-small-4", name: "Mistral Small 4 119B", apiId: "mistralai/mistral-small-4-119b-2603" },
  { key: "kimi-k2.6", name: "Kimi K2.6", apiId: "moonshotai/kimi-k2.6" },
  { key: "deepseek-v4-flash", name: "DeepSeek V4 Flash", apiId: "deepseek-ai/deepseek-v4-flash" },
  { key: "dracarys-llama", name: "Llama 3.1 70B Dracarys", apiId: "abacusai/dracarys-llama-3.1-70b-instruct" },
  { key: "nemotron-30b", name: "Nemotron 30B", apiId: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning" },
] as const;

function getModel(key: string) {
  return NIM_MODELS.find((m) => m.key === key) ?? NIM_MODELS[0];
}

// ============================================================
// BASE DE DONNÉES SQLITE
// ============================================================

const db = new Database("dragon.db", { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");
db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'Nouveau Chat',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    model TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
`);

interface Conversation { id: string; title: string; created_at: string; updated_at: string; }
interface Message { id: string; conversation_id: string; role: string; content: string; model: string | null; created_at: string; }

function listConversations(): Conversation[] {
  return db.query("SELECT id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC").all() as Conversation[];
}
function getConversation(id: string): Conversation | null {
  return (db.query("SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?").get(id) as Conversation) ?? null;
}
function createConversation(title = "Nouveau Chat"): Conversation {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.query("INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, title, now, now);
  return { id, title, created_at: now, updated_at: now };
}
function renameConversation(id: string, title: string) {
  db.query("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?").run(title, new Date().toISOString(), id);
}
function deleteConversation(id: string) {
  db.query("DELETE FROM messages WHERE conversation_id = ?").run(id);
  db.query("DELETE FROM conversations WHERE id = ?").run(id);
}
function touchConversation(id: string) {
  db.query("UPDATE conversations SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
}
function listMessages(conversationId: string): Message[] {
  return db.query("SELECT id, conversation_id, role, content, model, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC").all(conversationId) as Message[];
}
function addMessage(conversationId: string, role: "user" | "assistant", content: string, model: string | null = null): Message {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.query("INSERT INTO messages (id, conversation_id, role, content, model, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, conversationId, role, content, model, now);
  touchConversation(conversationId);
  return { id, conversation_id: conversationId, role, content, model, created_at: now };
}
function removeLastAssistantMessage(conversationId: string) {
  db.query("DELETE FROM messages WHERE id = (SELECT id FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1)").run(conversationId);
}
function getMessagesForApi(conversationId: string) {
  return listMessages(conversationId).map((m) => ({ role: m.role, content: m.content }));
}

// ============================================================
// CLIENT NVIDIA NIM (STREAMING SSE)
// ============================================================

interface ChatMessage { role: "user" | "assistant" | "system"; content: string; }

function plainApiError(status: number, statusText: string, contentType: string | null, body: string): string {
  const trimmed = body.trim();
  let detail = "";
  if (contentType?.includes("application/json")) {
    try {
      const json = JSON.parse(trimmed);
      detail = json?.error?.message || json?.message || json?.detail || JSON.stringify(json);
    } catch {
      detail = trimmed;
    }
  } else if (/^<!doctype html|^<html[\s>]/i.test(trimmed)) {
    const title = trimmed.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim();
    detail = title
      ? `Le fournisseur a renvoye une page HTML (${title}) au lieu d'une reponse API. Verifie la cle API et le modele selectionne.`
      : "Le fournisseur a renvoye une page HTML au lieu d'une reponse API. Verifie la cle API et le modele selectionne.";
  } else {
    detail = trimmed.replace(/\s+/g, " ");
  }
  return `Erreur NVIDIA NIM ${status} ${statusText}${detail ? ` - ${detail.slice(0, 500)}` : ""}`;
}

async function* streamChat(modelKey: string, messages: ChatMessage[], apiKeyOverride?: string): AsyncGenerator<string, void, unknown> {
  const model = getModel(modelKey);
  const apiKey = apiKeyOverride || process.env.NVIDIA_NIM_API_KEY || "";

  if (!apiKey || apiKey === "nvapi-votre-cle-ici") {
    yield "⚠️ Aucune clé API NVIDIA NIM configurée. Va dans les Paramètres (clique sur ton profil en bas à gauche → Paramètres → Clé API) et colle ta clé au format `nvapi-...`.";
    return;
  }

  const payload = { model: model.apiId, messages, temperature: 0.7, max_tokens: 2048, stream: true };

  let resp: Response;
  try {
    resp = await fetch(NIM_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    yield `❌ Erreur réseau : ${(e as Error).message}`;
    return;
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    yield `❌ ${plainApiError(resp.status, resp.statusText, resp.headers.get("content-type"), text)}`;
    return;
  }

  if (!resp.body) { yield "❌ Réponse sans body."; return; }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const event = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of event.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") return;
          try {
            const json = JSON.parse(data);
            const delta = json?.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta.length > 0) yield delta;
          } catch { /* ignore */ }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function makeTitle(text: string): string {
  const words = text.trim().split(/\s+/).slice(0, 6).join(" ");
  if (!words) return "Nouveau Chat";
  return words.length > 42 ? words.slice(0, 42) + "..." : words;
}

// ============================================================
// UTILITAIRES
// ============================================================

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function relativeTime(iso: string): string {
  const d = new Date(iso).getTime();
  const diff = Math.floor((Date.now() - d) / 1000);
  if (diff < 60) return "à l'instant";
  if (diff < 3600) return `il y a ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `il y a ${Math.floor(diff / 3600)} h`;
  if (diff < 604800) return `${Math.floor(diff / 86400)} j`;
  if (diff < 2592000) return `${Math.floor(diff / 604800)} sem.`;
  if (diff < 31536000) return `${Math.floor(diff / 2592000)} mois`;
  return `il y a ${Math.floor(diff / 31536000)} an`;
}

// ============================================================
// PARSER DIFF + COMMANDES
// ============================================================

interface DiffBlock { fileName: string; added: number; removed: number; lines: { type: "add" | "del" | "ctx"; text: string; num?: number }[]; }
interface CommandBlock { language: string; command: string; }

function parseDiffBlocks(text: string): { text: string; diffs: DiffBlock[] } {
  const diffs: DiffBlock[] = [];
  const out = text.replace(/```diff\s*\n([\s\S]*?)```/g, (_, body: string) => {
    const block = parseDiffBody(body);
    if (block) { diffs.push(block); return `__DRAGON_DIFF_${diffs.length - 1}__`; }
    return _;
  });
  return { text: out, diffs };
}

function parseDiffBody(body: string): DiffBlock | null {
  const lines = body.split("\n");
  let fileName = "fichier";
  const resultLines: DiffBlock["lines"] = [];
  for (const line of lines) {
    const addMatch = line.match(/^\+\+\+\s+(?:b\/)?(.+)$/);
    if (addMatch) { fileName = addMatch[1].trim(); continue; }
    if (line.startsWith("--- ") || line.startsWith("@@") || line.startsWith("diff --git")) continue;
    if (line.startsWith("+")) resultLines.push({ type: "add", text: line.slice(1) });
    else if (line.startsWith("-")) resultLines.push({ type: "del", text: line.slice(1) });
    else if (line.startsWith(" ")) resultLines.push({ type: "ctx", text: line.slice(1) });
    else if (line.trim() === "") resultLines.push({ type: "ctx", text: "" });
  }
  let num = 1; for (const l of resultLines) l.num = num++;
  const added = resultLines.filter((l) => l.type === "add").length;
  const removed = resultLines.filter((l) => l.type === "del").length;
  if (added === 0 && removed === 0 && resultLines.length === 0) return null;
  return { fileName, added, removed, lines: resultLines };
}

function renderDiffSummary(block: DiffBlock, index: number): string {
  const linesHtml = block.lines.map((l) => {
    const cls = l.type === "add" ? "diff-line-add" : l.type === "del" ? "diff-line-del" : "diff-line-ctx";
    const sign = l.type === "add" ? "+" : l.type === "del" ? "−" : " ";
    return `<div class="${cls}"><span class="diff-line-num">${l.num ?? ""}</span><span class="diff-line-sign">${sign}</span><span class="diff-line-text">${esc(l.text) || "&nbsp;"}</span></div>`;
  }).join("");
  return `<div class="diff-card" data-diff-idx="${index}"><div class="diff-summary"><div class="diff-file-info"><span class="diff-file-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></span><span class="diff-file-name">${esc(block.fileName)}</span></div><div class="diff-stats"><span class="diff-stat diff-added">+${block.added}</span><span class="diff-stat diff-removed">−${block.removed}</span></div><button type="button" class="diff-review-btn" onclick="dragonToggleDiff(${index})"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg><span>Review</span></button></div><div class="diff-detail" id="diff-detail-${index}" style="display:none"><div class="diff-lines">${linesHtml}</div></div></div>`;
}

function injectDiffCards(html: string, diffs: DiffBlock[]): string {
  return html.replace(/__DRAGON_DIFF_(\d+)__/g, (_, idx: string) => {
    const i = parseInt(idx, 10);
    return diffs[i] ? renderDiffSummary(diffs[i], i) : "";
  });
}

function parseCommandBlocks(text: string): { text: string; commands: CommandBlock[] } {
  const commands: CommandBlock[] = [];
  const out = text.replace(/```(bash|powershell|sh|cmd|shell|ps1)\s*\n([\s\S]*?)```/g, (_, lang: string, body: string) => {
    commands.push({ language: lang, command: body.trim() });
    return `__DRAGON_CMD_${commands.length - 1}__`;
  });
  return { text: out, commands };
}

function renderApprovalDialog(cmd: CommandBlock, index: number): string {
  const arrowIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>`;
  return `<div class="approval-card" data-cmd-idx="${index}"><div class="approval-header"><span class="approval-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span><span class="approval-title">Dragon Code veut exécuter une commande. L'autorises-tu ?</span></div><div class="approval-command"><div class="approval-command-lang">${esc(cmd.language)}</div><pre class="approval-command-code"><code>${esc(cmd.command)}</code></pre></div><div class="approval-options"><div class="approval-option selected" data-choice="yes" onclick="dragonSelectApproval(${index},'yes')"><span class="approval-radio">1</span><span class="approval-option-text">Oui</span></div><div class="approval-option" data-choice="no" onclick="dragonSelectApproval(${index},'no')"><span class="approval-radio">2</span><span class="approval-option-text">Non</span></div></div><div class="approval-actions"><button type="button" class="approval-btn approval-btn-ignore" onclick="dragonIgnoreCommand(${index})">Ignorer</button><button type="button" class="approval-btn approval-btn-submit" onclick="dragonSubmitApproval(${index})"><span>Soumettre</span>${arrowIcon}</button></div><div class="approval-hint">Appuie sur <kbd>Entrée</kbd> pour soumettre</div></div>`;
}

function injectCommandCards(html: string, commands: CommandBlock[], mode: string): string {
  if (mode === "full") {
    return html.replace(/__DRAGON_CMD_(\d+)__/g, (_, idx: string) => {
      const i = parseInt(idx, 10);
      return commands[i] ? `<pre class="code-block"><code>${esc(commands[i].command)}</code></pre>` : "";
    });
  }
  return html.replace(/__DRAGON_CMD_(\d+)__/g, (_, idx: string) => {
    const i = parseInt(idx, 10);
    return commands[i] ? renderApprovalDialog(commands[i], i) : "";
  });
}

function renderMarkdown(text: string, mode: string = "full"): string {
  const { text: textWithoutDiff, diffs } = parseDiffBlocks(text);
  const { text: textWithoutCmd, commands } = parseCommandBlocks(textWithoutDiff);
  const escaped = esc(textWithoutCmd);
  let out = escaped.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, _l, c) => `<pre class="code-block"><code>${c.trim()}</code></pre>`);
  out = out.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  out = out.replace(/^###\s+(.+)$/gm, '<h3 class="md-h3">$1</h3>');
  out = out.replace(/^##\s+(.+)$/gm, '<h2 class="md-h2">$1</h2>');
  out = out.replace(/^#\s+(.+)$/gm, '<h1 class="md-h1">$1</h1>');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" class="md-link">$1</a>');
  out = out.replace(/(^|\n)([-*])\s+(.+)/g, "$1<li>$3</li>");
  out = out.replace(/(<li>.*?<\/li>\n?)+/g, (m) => `<ul class="md-ul">${m}</ul>`);
  out = out.split(/\n\n+/).map((block) => block.startsWith("<") ? block : `<p>${block.replace(/\n/g, "<br>")}</p>`).join("\n");
  out = injectDiffCards(out, diffs);
  out = injectCommandCards(out, commands, mode);
  return out;
}

// ============================================================
// TEMPLATES HTML
// ============================================================

const icon = (name: string): string => {
  const icons: Record<string, string> = {
    plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
    search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
    sparkles: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2L12 3z"/></svg>`,
    chat: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
    edit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
    trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
    menu: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`,
    arrowUp: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>`,
    copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
    check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    refresh: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`,
    alert: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
    hand: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0"/><path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>`,
    chevron: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`,
    folder: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`,
  };
  return icons[name] ?? "";
};

function convItem(c: Conversation, isActive: boolean): string {
  return `<div class="conv-item ${isActive ? "active" : ""}" onclick="dragonLoadConv('${c.id}')"><span class="conv-icon">${icon("chat")}</span><div style="flex:1;min-width:0"><div class="conv-title">${esc(c.title)}</div><div class="conv-meta">${relativeTime(c.updated_at)}</div></div><div class="conv-actions"><button class="icon-btn" onclick="event.stopPropagation();dragonRename('${c.id}','${esc(c.title).replace(/'/g, "\\'")}')" title="Renommer">${icon("edit")}</button><button class="icon-btn" onclick="event.stopPropagation();dragonDelete('${c.id}')" title="Supprimer">${icon("trash")}</button></div></div>`;
}

function sidebar(currentConvId: string | null, convs: Conversation[]): string {
  return `<aside class="sidebar" id="sidebar"><div class="sidebar-header"><span class="dragon-logo">🐉</span></div><button class="btn-new-chat" onclick="dragonNewChat()">${icon("plus")}<span>Nouveau Chat</span></button><div class="sidebar-section">Navigation</div><div class="nav-item">${icon("plus")}<span>New task</span><span class="kbd">Ctrl+N</span></div><div class="nav-item">${icon("search")}<span>Search</span><span class="kbd">Ctrl+K</span></div><div class="nav-item">${icon("sparkles")}<span>Skills</span></div><div class="sidebar-section">Projets</div><div class="nav-item">${icon("folder")}<span>DragonCode Project</span></div><div class="sidebar-section">Conversations</div><div class="conv-list" id="conv-list">${convs.map((cv) => convItem(cv, cv.id === currentConvId)).join("")}</div><div class="sidebar-footer"><div class="profile" onclick="dragonOpenProfileMenu()" style="cursor:pointer"><div class="avatar">NM</div><div class="profile-info"><div class="profile-name">Naoufal</div><div class="profile-plan-row"><span class="profile-plan">Free</span><button type="button" class="upgrade-chip" onclick="dragonUpgrade(); event.stopPropagation();">Mettre à niveau</button></div></div></div></div></aside>`;
}

function header(): string {
  return `<div class="header"><div class="header-left"><button class="icon-btn" onclick="dragonToggleSidebar()" title="Menu">${icon("menu")}</button><span class="dragon-logo">🐉</span><h1>Dragon Code</h1></div></div>`;
}

function inputBar(currentModel: string): string {
  const model = getModel(currentModel);
  const options = NIM_MODELS.map((m) => `<div class="model-option ${m.key === currentModel ? "selected" : ""}" data-key="${m.key}" data-name="${esc(m.name)}" onclick="dragonSelectModel('${m.key}','${esc(m.name).replace(/'/g, "\\'")}')"><span class="model-option-name">${esc(m.name)}</span><span class="model-option-tag">NIM</span>${m.key === currentModel ? icon("check") : ""}</div>`).join("");
  return `<div class="input-bar"><form class="input-wrap" id="input-form" onsubmit="return dragonSend(event)"><div class="input-row-top"><button type="button" class="bar-icon-btn" title="Ajouter un fichier">${icon("plus")}</button><textarea id="input-field" placeholder="Faites ce que vous voulez" rows="1" oninput="dragonAutoGrow(this)"></textarea></div><div class="input-row-bottom"><div class="input-row-left"><div class="mode-dropdown" id="mode-dropdown"><button class="mode-trigger" type="button" onclick="dragonToggleModeMenu(event)" title="Mode d'accès"><span class="mode-icon" id="mode-icon">${icon("alert")}</span><span class="mode-label" id="mode-label">Accès complet</span>${icon("chevron")}</button><div class="mode-menu" id="mode-menu"><div class="mode-option selected" data-mode="full" data-icon="alert" onclick="dragonSelectMode('full','Accès complet','alert')"><span class="mode-icon-wrap">${icon("alert")}</span><div class="mode-option-text"><div class="mode-option-title">Accès complet</div><div class="mode-option-desc">Exécute sans demander</div></div></div><div class="mode-option" data-mode="approval" data-icon="hand" onclick="dragonSelectMode('approval','Demander une approbation','hand')"><span class="mode-icon-wrap">${icon("hand")}</span><div class="mode-option-text"><div class="mode-option-title">Demander une approbation</div><div class="mode-option-desc">Approuve chaque commande</div></div></div></div></div><div class="model-dropdown" id="model-dropdown"><button class="bar-model-trigger" type="button" onclick="dragonToggleModelMenu(event)" title="Changer de modèle"><span class="bar-model-name" id="toolbar-model-name">${esc(model.name)}</span>${icon("chevron")}</button><div class="model-menu" id="model-menu"><div class="model-menu-header">Modèles NVIDIA NIM</div>${options}</div></div></div><button type="submit" class="send-btn" id="send-btn" title="Envoyer">${icon("arrowUp")}</button></div></form><div class="disclaimer">L'IA peut se tromper, veuillez vérifier sa réponse.</div></div>`;
}

function welcome(currentModel: string): string {
  return `<div class="chat-area" id="chat-area"><div class="welcome"><div class="welcome-logo">🐉</div><h2>Dragon Code</h2><p class="subtitle">Propulsé par NVIDIA NIM</p><div class="suggestion-chips"><div class="suggestion-chip" onclick="dragonSuggest('Explique-moi comment fonctionne l\\'intelligence artificielle')">💡 Explique-moi un concept</div><div class="suggestion-chip" onclick="dragonSuggest('Écris un script Python qui trie une liste de nombres')">🔧 Aide-moi à coder</div><div class="suggestion-chip" onclick="dragonSuggest('Rédige un email professionnel pour demander un rendez-vous')">✍️ Rédige un texte</div></div></div></div>${inputBar(currentModel)}`;
}

function messageBubble(m: Message): string {
  if (m.role === "user") return `<div class="msg-row user"><div class="avatar user">U</div><div class="msg-bubble">${esc(m.content)}</div></div>`;
  const modelName = m.model ? getModel(m.model).name : null;
  return `<div class="msg-row assistant"><div class="avatar dragon">🐉</div><div class="msg-bubble"><div class="msg-author">Dragon Agent</div><div class="msg-content" data-raw-content="${Buffer.from(m.content).toString("base64")}">${renderMarkdown(m.content, "full")}</div><div class="msg-footer">${modelName ? `<span class="model-tag">📄 ${esc(modelName)}</span>` : ""}<span class="spacer"></span><button class="icon-btn copy-btn" data-copy-text="${esc(m.content)}" title="Copier">${icon("copy")}</button><button class="icon-btn" onclick="dragonReprompt()" title="Reprompter">${icon("refresh")}</button></div></div></div>`;
}

function chatArea(messages: Message[], currentModel: string): string {
  return messages.length === 0 ? welcome(currentModel) : `<div class="chat-area" id="chat-area"><div class="chat-messages" id="chat-messages">${messages.map((m) => messageBubble(m)).join("")}</div></div>${inputBar(currentModel)}`;
}

function layout(body: string, currentModel: string, currentConvId: string | null, convs: Conversation[]): string {
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>🐉 Dragon Code</title><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet"><style>${CSS}</style></head><body><div class="app"><div class="app-body">${sidebar(currentConvId, convs)}<main class="main">${header()}${body}</main></div></div><div id="modal-root"></div><div id="toast-root"></div><div id="page-root"></div><script>window.NIM_MODELS_JS = ${JSON.stringify(NIM_MODELS.map((m) => ({ key: m.key, name: m.name })))}; window.DRAGON = { convId: ${JSON.stringify(currentConvId)}, model: ${JSON.stringify(currentModel)} };</script><script>${JS_FRONTEND}</script></body></html>`;
}

// ============================================================
// CSS (tout le thème)
// ============================================================

const CSS = `
:root {
  --bg-primary:#09090b; --bg-secondary:#111113; --bg-tertiary:#18181b;
  --bg-surface:#1c1c1f; --bg-elevated:#27272a; --border:#27272a; --border-subtle:#1f1f23;
  --text-primary:#fafafa; --text-secondary:#a1a1aa; --text-muted:#71717a;
  --accent-green:#10b981; --accent-green-dim:#064e3b; --accent-green-hover:#0d9968;
  --user-bubble:#1e3a5f; --user-text:#93c5fd; --stop-red:#ef4444; --orange:#f97316;
}
* { box-sizing:border-box; margin:0; padding:0; }
html, body { height:100%; background:var(--bg-primary); color:var(--text-primary); font-family:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; font-size:14px; line-height:1.5; -webkit-font-smoothing:antialiased; }
.app { display:flex; flex-direction:column; height:100vh; overflow:hidden; }
.app-body { display:flex; flex:1; min-height:0; overflow:hidden; }
.sidebar { width:240px; flex-shrink:0; background:var(--bg-secondary); border-right:1px solid var(--border-subtle); display:flex; flex-direction:column; padding:16px 14px 14px; transition:width 0.2s ease,transform 0.2s ease; }
.sidebar.collapsed { width:0; padding:0; overflow:hidden; }
.sidebar-header { display:flex; align-items:center; justify-content:center; gap:8px; margin-bottom:12px; font-weight:600; font-size:16px; }
.sidebar-header .dragon-logo { font-size:26px; }
.sidebar-section { font-size:10px; font-weight:600; color:var(--text-muted); letter-spacing:0.06em; text-transform:uppercase; margin:16px 0 6px; padding:0 10px; line-height:1; }
.nav-item { display:flex; align-items:center; gap:10px; padding:8px 10px; border-radius:8px; color:var(--text-secondary); cursor:pointer; font-size:13px; line-height:1; transition:background 0.15s; }
.nav-item:hover { background:var(--bg-elevated); color:var(--text-primary); }
.nav-item svg { width:16px; height:16px; flex-shrink:0; }
.nav-item .kbd { margin-left:auto; font-size:10px; color:var(--text-muted); font-family:ui-monospace,monospace; background:var(--bg-tertiary); padding:1px 5px; border-radius:4px; }
.btn-new-chat { display:flex; align-items:center; justify-content:center; gap:8px; width:100%; padding:10px 14px; background:var(--bg-elevated); border:none; border-radius:12px; color:var(--text-primary); font-size:13px; font-weight:500; line-height:1; cursor:pointer; transition:background 0.15s,transform 0.1s; }
.btn-new-chat svg { width:16px; height:16px; flex-shrink:0; }
.btn-new-chat:hover { background:#303035; }
.btn-new-chat:active { transform:scale(0.98); }
.conv-list { flex:1; overflow-y:auto; min-height:0; }
.conv-item { display:flex; align-items:flex-start; gap:8px; padding:8px 10px; border-radius:8px; cursor:pointer; transition:background 0.15s; }
.conv-item:hover { background:var(--bg-elevated); }
.conv-item.active { background:var(--bg-elevated); }
.conv-item .conv-icon { color:var(--text-muted); flex-shrink:0; display:inline-flex; align-items:center; justify-content:center; width:16px; height:16px; margin-top:1px; }
.conv-item .conv-icon svg { width:14px; height:14px; }
.conv-item.active .conv-icon { color:var(--accent-green); }
.conv-title { flex:1; font-size:12px; color:var(--text-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.conv-item.active .conv-title { color:var(--text-primary); }
.conv-meta { font-size:10px; color:var(--text-muted); margin-top:2px; }
.conv-actions { display:none; gap:2px; }
.conv-item:hover .conv-actions { display:flex; }
.icon-btn { width:28px; height:28px; display:inline-flex; align-items:center; justify-content:center; background:transparent; border:none; color:var(--text-muted); cursor:pointer; border-radius:6px; transition:all 0.15s; padding:0; box-sizing:border-box; }
.icon-btn:hover { background:var(--bg-surface); color:var(--text-primary); }
.icon-btn svg { width:14px; height:14px; }
.sidebar-footer { margin-top:12px; padding-top:12px; border-top:1px solid var(--border-subtle); font-size:10px; color:var(--text-muted); }
.profile { display:flex; align-items:center; gap:10px; padding:8px 4px; }
.avatar { width:32px; height:32px; border-radius:50%; background:var(--accent-green-dim); color:var(--accent-green); display:inline-flex; align-items:center; justify-content:center; font-weight:600; font-size:13px; flex-shrink:0; line-height:1; }
.avatar.user { background:var(--user-bubble); color:var(--user-text); }
.avatar.dragon { background:var(--accent-green-dim); color:var(--accent-green); }
.profile-info { flex:1; min-width:0; }
.profile-name { font-size:13px; color:var(--text-primary); font-weight:500; }
.profile-plan-row { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:2px; margin-right:-6px; }
.profile-plan { font-size:11px; color:var(--text-muted); }
.upgrade-chip { display:inline-flex; align-items:center; background:var(--accent-green); color:#ffffff; border:none; border-radius:12px; padding:3px 9px; font-size:11px; font-weight:500; font-family:inherit; line-height:1.4; cursor:pointer; transition:background 0.15s,transform 0.1s; }
.upgrade-chip:hover { background:var(--accent-green-hover); transform:translateY(-1px); }
.upgrade-chip:active { transform:translateY(0); }
.main { flex:1; display:flex; flex-direction:column; min-width:0; background:var(--bg-primary); overflow:hidden; }
.header { display:flex; align-items:center; justify-content:space-between; padding:10px 24px; border-bottom:1px solid var(--border-subtle); gap:16px; height:52px; box-sizing:border-box; flex-shrink:0; }
.header-left { display:flex; align-items:center; gap:10px; }
.header-left .dragon-logo { font-size:22px; line-height:1; display:inline-flex; align-items:center; }
.header-left h1 { font-size:18px; font-weight:600; line-height:1; margin:0; }
.chat-area { flex:1; overflow-y:auto; padding:16px 0; min-height:0; }
.chat-messages { max-width:800px; margin:0 auto; padding:0 24px; display:flex; flex-direction:column; gap:4px; }
.welcome { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:40px 24px; min-height:60vh; }
.welcome-logo { width:100px; height:100px; border-radius:50%; background:var(--accent-green-dim); display:flex; align-items:center; justify-content:center; font-size:56px; box-shadow:0 0 40px rgba(16,185,129,0.2); margin-bottom:12px; }
.welcome h2 { font-size:28px; font-weight:700; margin-bottom:4px; }
.welcome .subtitle { font-size:14px; color:var(--text-muted); margin-bottom:24px; }
.suggestion-chips { display:flex; flex-wrap:wrap; gap:8px; justify-content:center; }
.suggestion-chip { background:var(--bg-surface); border:1px solid var(--border); border-radius:20px; padding:9px 14px; color:var(--text-secondary); font-size:12px; line-height:1; cursor:pointer; transition:all 0.15s; display:inline-flex; align-items:center; }
.suggestion-chip:hover { background:var(--bg-elevated); color:var(--text-primary); border-color:var(--accent-green); }
.msg-row { display:flex; gap:10px; padding:6px 0; align-items:flex-start; }
.msg-row.user { flex-direction:row-reverse; }
.msg-bubble { max-width:600px; padding:10px 16px; border-radius:20px; font-size:14px; line-height:1.55; overflow-wrap:break-word; word-break:break-word; }
.msg-content { overflow-x:auto; max-width:100%; }
.msg-row.user .msg-bubble { background:var(--user-bubble); color:#e0e7ff; }
.msg-row.assistant .msg-bubble { background:var(--bg-surface); border:1px solid var(--border-subtle); color:var(--text-primary); }
.msg-author { font-size:12px; font-weight:600; color:var(--accent-green); margin-bottom:4px; }
.msg-footer { display:flex; align-items:center; gap:6px; margin-top:8px; font-size:10px; color:var(--text-muted); }
.msg-footer .model-tag { font-style:italic; }
.msg-footer .spacer { flex:1; }
.typing { display:flex; align-items:center; gap:10px; padding:4px 0; }
.typing .msg-bubble { display:flex; align-items:center; gap:10px; }
.spinner { width:16px; height:16px; border:2px solid var(--accent-green-dim); border-top-color:var(--accent-green); border-radius:50%; animation:spin 0.8s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }
.input-bar { padding:6px 24px 16px; background:var(--bg-primary); max-width:800px; margin:0 auto; width:100%; flex-shrink:0; }
.input-wrap { display:flex; flex-direction:column; gap:6px; background:var(--bg-tertiary); border:1px solid var(--border); border-radius:24px; padding:10px 10px 8px; transition:border-color 0.15s,background 0.15s; box-sizing:border-box; }
.input-wrap:focus-within { border-color:var(--accent-green); background:var(--bg-elevated); }
.input-row-top { display:flex; align-items:center; gap:8px; width:100%; }
.input-row-bottom { display:flex; align-items:center; justify-content:space-between; gap:8px; width:100%; padding:0 4px; }
.input-row-left { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.input-wrap textarea { flex:1; background:transparent; border:none; outline:none; color:var(--text-primary); font-family:inherit; font-size:14px; resize:none; padding:8px 4px; min-height:24px; max-height:200px; line-height:1.5; align-self:center; }
.input-wrap textarea::placeholder { color:var(--text-muted); }
.send-btn { width:36px; height:36px; flex-shrink:0; border:none; border-radius:50%; background:var(--accent-green); color:white; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; transition:transform 0.15s,background 0.15s; padding:0; box-sizing:border-box; }
.send-btn:hover { background:var(--accent-green-hover); transform:scale(1.08); }
.send-btn:active { transform:scale(0.85); }
.send-btn.stop { background:var(--stop-red); }
.send-btn.stop:hover { background:#dc2626; }
.send-btn svg { width:20px; height:20px; }
.bar-icon-btn { display:inline-flex; align-items:center; justify-content:center; width:32px; height:32px; background:transparent; border:none; color:var(--text-secondary); cursor:pointer; border-radius:8px; flex-shrink:0; transition:all 0.15s; padding:0; }
.bar-icon-btn:hover { background:var(--bg-surface); color:var(--text-primary); }
.bar-icon-btn svg { width:18px; height:18px; }
.bar-badge { display:inline-flex; align-items:center; gap:5px; background:transparent; border:none; color:var(--orange); cursor:pointer; font-size:13px; font-family:inherit; line-height:1; flex-shrink:0; padding:6px 8px; border-radius:8px; transition:background 0.15s; }
.bar-badge:hover { background:rgba(249,115,22,0.1); }
.bar-badge svg { width:14px; height:14px; }
.bar-badge svg:last-child { width:12px; height:12px; opacity:0.8; }
.model-dropdown { position:relative; display:inline-flex; flex-shrink:0; }
.bar-model-trigger { display:inline-flex; align-items:center; gap:5px; background:transparent; border:none; border-radius:8px; padding:6px 8px; color:var(--text-secondary); cursor:pointer; font-size:13px; font-family:inherit; line-height:1; transition:all 0.15s; }
.bar-model-trigger:hover { background:var(--bg-surface); color:var(--text-primary); }
.bar-model-trigger svg { width:12px; height:12px; opacity:0.7; transition:transform 0.2s; }
.bar-model-trigger:hover svg { opacity:1; }
.bar-model-name { max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.model-menu { display:none; position:absolute; bottom:calc(100% + 6px); left:0; min-width:240px; background:var(--bg-secondary); border:1px solid var(--border); border-radius:10px; box-shadow:0 8px 24px rgba(0,0,0,0.5); padding:6px; z-index:50; max-height:320px; overflow-y:auto; }
.model-menu.open { display:block; animation:menuIn 0.15s ease-out; }
@keyframes menuIn { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:translateY(0); } }
.model-menu-header { font-size:10px; font-weight:600; color:var(--text-muted); letter-spacing:0.06em; text-transform:uppercase; padding:6px 10px 4px; }
.model-option { display:flex; align-items:center; gap:8px; padding:7px 10px; border-radius:6px; cursor:pointer; font-size:13px; color:var(--text-secondary); transition:background 0.12s; line-height:1; }
.model-option:hover { background:var(--bg-elevated); color:var(--text-primary); }
.model-option.selected { color:var(--accent-green); }
.model-option-name { flex:1; }
.model-option-tag { font-size:10px; color:var(--text-muted); background:var(--bg-tertiary); padding:2px 6px; border-radius:4px; }
.model-option.selected .model-option-tag { color:var(--accent-green); background:var(--accent-green-dim); }
.model-option svg { width:14px; height:14px; color:var(--accent-green); }
.disclaimer { text-align:center; font-size:11px; color:var(--text-muted); margin-top:6px; }
.mode-dropdown { position:relative; display:inline-flex; flex-shrink:0; }
.mode-trigger { display:inline-flex; align-items:center; gap:6px; background:transparent; border:1px solid var(--border); border-radius:8px; padding:5px 10px; color:var(--text-secondary); cursor:pointer; font-size:12px; font-family:inherit; line-height:1; transition:all 0.15s; }
.mode-trigger:hover { background:var(--bg-surface); color:var(--text-primary); border-color:var(--text-muted); }
.mode-trigger .mode-icon { color:var(--text-secondary); }
.mode-trigger:hover .mode-icon { color:var(--text-primary); }
.mode-trigger svg { width:14px; height:14px; opacity:0.9; }
.mode-icon { display:inline-flex; align-items:center; flex-shrink:0; }
.mode-icon svg { width:14px; height:14px; }
.mode-label { white-space:nowrap; overflow:visible; }
.mode-menu { display:none; position:absolute; bottom:calc(100% + 6px); left:0; min-width:320px; background:var(--bg-secondary); border:1px solid var(--border); border-radius:10px; box-shadow:0 8px 24px rgba(0,0,0,0.6); padding:6px; z-index:200; }
.mode-menu.open { display:block; animation:menuIn 0.15s ease-out; }
.mode-option { display:flex; align-items:flex-start; gap:10px; padding:8px 10px; border-radius:6px; cursor:pointer; font-size:12px; color:var(--text-secondary); transition:background 0.12s; line-height:1.3; overflow:hidden; }
.mode-option:hover { background:var(--bg-elevated); color:var(--text-primary); }
.mode-option.selected { color:var(--accent-green); }
.mode-icon-wrap { display:inline-flex; align-items:center; justify-content:center; width:18px; height:18px; margin-top:1px; flex-shrink:0; color:var(--orange); }
.mode-option.selected .mode-icon-wrap { color:var(--accent-green); }
.mode-icon-wrap svg { width:16px; height:16px; }
.mode-option-text { flex:1; min-width:0; }
.mode-option-title { font-weight:500; }
.mode-option-desc { font-size:11px; color:var(--text-muted); margin-top:2px; }
.mode-option.selected .mode-option-desc { color:var(--accent-green-dim); }
.mode-option .mode-check { display:none; align-items:center; justify-content:center; width:16px; height:16px; color:var(--accent-green); margin-top:2px; flex:0 0 16px; overflow:hidden; }
.mode-option.selected .mode-check { display:inline-flex; }
.mode-option .mode-check svg { display:block; width:14px; height:14px; max-width:14px; max-height:14px; flex:0 0 14px; }
.diff-card { margin:10px 0; background:var(--bg-secondary); border:1px solid var(--border); border-radius:10px; overflow:hidden; }
.diff-summary { display:flex; align-items:center; gap:12px; padding:10px 14px; background:var(--bg-tertiary); }
.diff-file-info { display:flex; align-items:center; gap:8px; flex:1; min-width:0; }
.diff-file-icon { color:var(--text-muted); display:inline-flex; }
.diff-file-icon svg { width:16px; height:16px; }
.diff-file-name { font-size:13px; font-weight:500; color:var(--text-primary); font-family:ui-monospace,"SF Mono",monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.diff-stats { display:flex; align-items:center; gap:8px; flex-shrink:0; }
.diff-stat { font-size:12px; font-weight:600; font-family:ui-monospace,monospace; padding:2px 8px; border-radius:8px; line-height:1.4; }
.diff-added { color:#4ade80; background:rgba(16,185,129,0.15); }
.diff-removed { color:#f87171; background:rgba(239,68,68,0.15); }
.diff-review-btn { display:inline-flex; align-items:center; gap:5px; background:transparent; border:1px solid var(--border); border-radius:8px; padding:5px 10px; color:var(--text-secondary); font-size:12px; font-family:inherit; line-height:1; cursor:pointer; flex-shrink:0; transition:all 0.15s; }
.diff-review-btn:hover { background:var(--bg-elevated); color:var(--text-primary); border-color:var(--accent-green); }
.diff-review-btn svg { width:13px; height:13px; }
.diff-detail { border-top:1px solid var(--border-subtle); background:#0a0a0c; max-height:400px; overflow-y:auto; }
.diff-lines { font-family:ui-monospace,"SF Mono","Cascadia Code",monospace; font-size:12px; line-height:1.6; }
.diff-line-add, .diff-line-del, .diff-line-ctx { display:flex; align-items:flex-start; padding:0; white-space:pre; }
.diff-line-num { display:inline-block; width:40px; text-align:right; padding:0 8px; color:var(--text-muted); background:var(--bg-secondary); user-select:none; flex-shrink:0; font-size:11px; }
.diff-line-sign { display:inline-block; width:18px; text-align:center; user-select:none; flex-shrink:0; font-weight:700; }
.diff-line-text { flex:1; padding-right:12px; white-space:pre-wrap; word-break:break-word; }
.diff-line-add { background:rgba(16,185,129,0.1); }
.diff-line-add .diff-line-sign { color:#4ade80; }
.diff-line-add .diff-line-text { color:#bbf7d0; }
.diff-line-del { background:rgba(239,68,68,0.1); }
.diff-line-del .diff-line-sign { color:#f87171; }
.diff-line-del .diff-line-text { color:#fecaca; }
.diff-line-ctx .diff-line-sign { color:var(--text-muted); }
.diff-line-ctx .diff-line-text { color:var(--text-secondary); }
.approval-card { margin:10px 0; background:var(--bg-secondary); border:1px solid var(--border); border-left:3px solid var(--orange); border-radius:10px; overflow:hidden; }
.approval-header { display:flex; align-items:center; gap:10px; padding:12px 14px; background:rgba(249,115,22,0.05); }
.approval-icon { color:var(--orange); display:inline-flex; flex-shrink:0; }
.approval-icon svg { width:18px; height:18px; }
.approval-title { font-size:13px; font-weight:500; color:var(--text-primary); }
.approval-command { border-top:1px solid var(--border-subtle); border-bottom:1px solid var(--border-subtle); background:#0a0a0c; }
.approval-command-lang { font-size:10px; font-weight:600; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.06em; padding:6px 12px 0; }
.approval-command-code { margin:0; padding:8px 12px 12px; overflow-x:auto; font-family:ui-monospace,"SF Mono",monospace; font-size:12px; color:#d4d4d8; line-height:1.5; white-space:pre; }
.approval-command-code code { font-family:inherit; }
.approval-options { padding:8px; display:flex; flex-direction:column; gap:2px; }
.approval-option { display:flex; align-items:center; gap:10px; padding:8px 10px; border-radius:6px; cursor:pointer; font-size:13px; color:var(--text-secondary); transition:background 0.12s; line-height:1.3; }
.approval-option:hover { background:var(--bg-elevated); color:var(--text-primary); }
.approval-option.selected { background:rgba(16,185,129,0.1); color:var(--accent-green); }
.approval-radio { display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; border-radius:50%; border:1.5px solid var(--border); font-size:11px; font-weight:600; color:var(--text-muted); flex-shrink:0; background:var(--bg-tertiary); }
.approval-option.selected .approval-radio { border-color:var(--accent-green); background:var(--accent-green); color:white; }
.approval-actions { display:flex; justify-content:flex-end; gap:8px; padding:8px 12px 4px; }
.approval-btn { display:inline-flex; align-items:center; gap:5px; border:none; border-radius:8px; padding:8px 16px; font-size:13px; font-family:inherit; font-weight:500; line-height:1; cursor:pointer; transition:all 0.15s; }
.approval-btn svg { width:14px; height:14px; }
.approval-btn-ignore { background:transparent; color:var(--text-muted); }
.approval-btn-ignore:hover { background:var(--bg-elevated); color:var(--text-primary); }
.approval-btn-submit { background:var(--accent-green); color:white; }
.approval-btn-submit:hover { background:var(--accent-green-hover); transform:translateY(-1px); box-shadow:0 4px 12px rgba(16,185,129,0.35); }
.approval-hint { padding:0 14px 10px; font-size:11px; color:var(--text-muted); text-align:right; }
.approval-hint kbd { background:var(--bg-tertiary); border:1px solid var(--border); border-radius:4px; padding:1px 6px; font-family:ui-monospace,monospace; font-size:10px; color:var(--text-secondary); }
.code-block { background:#0a0a0c; border:1px solid var(--border-subtle); border-radius:8px; padding:12px 14px; overflow-x:auto; margin:8px 0; font-family:ui-monospace,"SF Mono",monospace; font-size:12px; color:#d4d4d8; max-width:100%; white-space:pre; word-break:normal; }
.code-block code { display:block; white-space:pre; word-break:normal; overflow-wrap:normal; }
.inline-code { background:var(--bg-tertiary); padding:1px 6px; border-radius:4px; font-family:ui-monospace,monospace; font-size:12px; color:var(--accent-green); }
.md-h1, .md-h2, .md-h3 { color:var(--text-primary); margin:12px 0 6px; }
.md-h1 { font-size:18px; }
.md-h2 { font-size:16px; }
.md-h3 { font-size:14px; }
.md-link { color:var(--accent-green); text-decoration:underline; }
.md-ul { padding-left:20px; margin:6px 0; }
.toast { position:fixed; bottom:24px; left:50%; transform:translateX(-50%); background:var(--accent-green); color:white; padding:8px 16px; border-radius:10px; font-size:13px; z-index:200; animation:toastIn 0.2s; }
.toast.error { background:var(--stop-red); }
@keyframes toastIn { from { opacity:0; transform:translate(-50%,10px); } to { opacity:1; transform:translate(-50%,0); } }
::-webkit-scrollbar { width:8px; height:8px; }
::-webkit-scrollbar-track { background:transparent; }
::-webkit-scrollbar-thumb { background:var(--bg-elevated); border-radius:4px; }
::-webkit-scrollbar-thumb:hover { background:#3f3f46; }
.modal-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.7); display:flex; align-items:center; justify-content:center; z-index:100; animation:fadeIn 0.15s; }
@keyframes fadeIn { from { opacity:0; } to { opacity:1; } }
.modal { background:var(--bg-secondary); border:1px solid var(--border); border-radius:14px; padding:24px; width:90%; max-width:400px; max-height:80vh; overflow-y:auto; }
.modal h3 { font-size:16px; margin-bottom:12px; color:var(--text-primary); }
.modal input[type="text"] { width:100%; background:var(--bg-surface); border:1px solid var(--border); border-radius:10px; padding:10px 12px; color:var(--text-primary); font-family:inherit; font-size:14px; outline:none; }
.modal input[type="text"]:focus { border-color:var(--accent-green); }
.modal-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:16px; }
.btn { padding:8px 16px; border-radius:10px; border:none; cursor:pointer; font-family:inherit; font-size:13px; font-weight:500; transition:background 0.15s; }
.btn-ghost { background:transparent; color:var(--text-secondary); }
.btn-ghost:hover { background:var(--bg-elevated); color:var(--text-primary); }
.btn-primary { background:var(--accent-green); color:white; }
.btn-primary:hover { background:var(--accent-green-hover); }
.btn-danger { background:transparent; border:1px solid var(--stop-red); color:#f87171; padding:9px 16px; border-radius:8px; font-size:13px; font-weight:500; cursor:pointer; font-family:inherit; align-self:flex-start; transition:all 0.15s; }
.btn-danger:hover { background:rgba(239,68,68,0.1); }
.profile-menu { background:var(--bg-secondary); border:1px solid var(--border); border-radius:14px; width:90%; max-width:360px; overflow:hidden; box-shadow:0 12px 32px rgba(0,0,0,0.6); animation:menuIn 0.15s ease-out; }
.profile-menu-header { display:flex; align-items:center; gap:14px; padding:20px; background:var(--bg-tertiary); border-bottom:1px solid var(--border-subtle); }
.profile-menu-name { font-size:16px; font-weight:600; color:var(--text-primary); line-height:1.2; }
.profile-menu-plan { font-size:12px; color:var(--text-muted); margin-top:2px; }
.profile-menu-items { padding:6px; }
.profile-menu-item { display:flex; align-items:center; gap:12px; width:100%; padding:10px 12px; background:transparent; border:none; border-radius:10px; color:var(--text-primary); font-size:14px; font-family:inherit; text-align:left; cursor:pointer; transition:background 0.12s; line-height:1; }
.profile-menu-item:hover { background:var(--bg-elevated); }
.profile-menu-item svg:last-child { margin-left:auto; width:16px; height:16px; color:var(--text-muted); display:block; }
.profile-menu-icon { display:inline-flex; align-items:center; justify-content:center; width:32px; height:32px; background:var(--bg-tertiary); border-radius:8px; color:var(--accent-green); flex-shrink:0; }
.profile-menu-icon svg { width:16px; height:16px; display:block; margin:auto; }
.profile-menu-text { flex:1; font-weight:500; }
.page-fullscreen { position:fixed; inset:0; z-index:500; background:var(--bg-primary); display:flex; flex-direction:column; animation:pageIn 0.2s ease-out; }
@keyframes pageIn { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
.page-header { display:flex; align-items:center; gap:12px; padding:14px 24px; border-bottom:1px solid var(--border-subtle); height:52px; box-sizing:border-box; flex-shrink:0; background:var(--bg-primary); }
.page-header h2 { font-size:18px; font-weight:600; color:var(--text-primary); margin:0; line-height:1; }
.page-back-btn { width:36px; height:36px; border-radius:8px; display:inline-flex; align-items:center; justify-content:center; background:transparent; border:none; color:var(--text-secondary); cursor:pointer; transition:all 0.15s; padding:0; }
.page-back-btn:hover { background:var(--bg-elevated); color:var(--text-primary); }
.page-back-btn svg { width:20px; height:20px; }
.page-content { flex:1; overflow-y:auto; padding:32px 24px; max-width:640px; width:100%; margin:0 auto; box-sizing:border-box; }
.page-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:24px; padding-top:20px; border-top:1px solid var(--border-subtle); }
.settings-layout { flex:1; display:flex; overflow:hidden; min-height:0; }
.settings-sidebar { width:220px; flex-shrink:0; background:var(--bg-secondary); border-right:1px solid var(--border-subtle); padding:16px 10px; overflow-y:auto; }
.settings-nav-item { display:flex; align-items:center; gap:10px; width:100%; padding:10px 12px; background:transparent; border:none; border-radius:8px; color:var(--text-secondary); font-size:13px; font-family:inherit; text-align:left; cursor:pointer; transition:all 0.12s; margin-bottom:2px; line-height:1; }
.settings-nav-item:hover { background:var(--bg-elevated); color:var(--text-primary); }
.settings-nav-item.active { background:var(--accent-green-dim); color:var(--accent-green); }
.settings-nav-icon { display:inline-flex; align-items:center; justify-content:center; width:18px; height:18px; flex-shrink:0; }
.settings-nav-icon svg { width:16px; height:16px; display:block; }
.settings-nav-label { flex:1; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.settings-main { flex:1; overflow-y:auto; padding:28px 32px; max-width:720px; }
.section-title { font-size:18px; font-weight:600; color:var(--text-primary); margin:0 0 20px 0; line-height:1; }
.settings-section-content { display:flex; flex-direction:column; gap:24px; }
.settings-section { display:flex; flex-direction:column; gap:6px; }
.settings-label { font-size:12px; font-weight:600; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.04em; }
.settings-input { width:100%; background:var(--bg-surface); border:1px solid var(--border); border-radius:8px; padding:10px 12px; color:var(--text-primary); font-family:inherit; font-size:13px; outline:none; transition:border-color 0.15s; box-sizing:border-box; }
.settings-input:focus { border-color:var(--accent-green); }
.settings-select { cursor:pointer; appearance:none; background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2371717a' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E"); background-repeat:no-repeat; background-position:right 12px center; padding-right:32px; }
.settings-hint { font-size:11px; color:var(--text-muted); line-height:1.4; }
.settings-divider { height:1px; background:var(--border-subtle); margin:4px 0; }
.settings-plan-row { display:flex; align-items:center; gap:12px; }
.settings-plan-badge { display:inline-flex; align-items:center; background:var(--bg-surface); border:1px solid var(--border); border-radius:12px; padding:5px 12px; font-size:12px; color:var(--text-secondary); }
.settings-about { background:var(--bg-surface); border:1px solid var(--border); border-radius:8px; padding:12px; font-size:12px; color:var(--text-muted); line-height:1.6; }
.settings-about div:first-child { color:var(--accent-green); font-weight:600; font-size:13px; margin-bottom:4px; }
.profile-page { max-width:440px; }
.profile-page-content { display:flex; flex-direction:column; gap:16px; margin-bottom:16px; }
.profile-avatar-large { display:flex; justify-content:center; padding:12px 0; }
.settings-page { max-width:520px; max-height:80vh; overflow-y:auto; }
.settings-content { display:flex; flex-direction:column; gap:20px; margin-bottom:16px; }
.settings-models-list { display:flex; flex-direction:column; gap:6px; }
.settings-model-item { display:flex; align-items:center; gap:10px; padding:10px 14px; background:var(--bg-surface); border:1px solid var(--border); border-radius:8px; font-size:13px; }
.settings-model-item.current { border-color:var(--accent-green); background:rgba(16,185,129,0.08); }
.settings-model-name { flex:1; color:var(--text-primary); font-weight:500; }
.settings-model-tag { font-size:10px; color:var(--text-muted); background:var(--bg-tertiary); padding:2px 6px; border-radius:4px; font-weight:600; }
.settings-model-current { font-size:11px; color:var(--accent-green); font-weight:600; }
.settings-mode-desc { display:flex; flex-direction:column; gap:10px; }
.settings-mode-item { padding:12px 14px; background:var(--bg-surface); border:1px solid var(--border); border-radius:8px; }
.settings-mode-name { font-size:13px; font-weight:600; color:var(--text-primary); margin-bottom:4px; }
.settings-mode-text { font-size:12px; color:var(--text-muted); line-height:1.5; }
.settings-about-card { display:flex; flex-direction:column; align-items:center; text-align:center; padding:32px 24px; background:var(--bg-surface); border:1px solid var(--border); border-radius:12px; gap:8px; }
.settings-about-logo { font-size:56px; line-height:1; margin-bottom:8px; }
.settings-about-name { font-size:22px; font-weight:700; color:var(--text-primary); }
.settings-about-version { font-size:13px; color:var(--accent-green); font-weight:600; }
.settings-about-desc { font-size:13px; color:var(--text-secondary); margin-top:8px; }
.settings-about-tech { font-size:11px; color:var(--text-muted); font-family:ui-monospace,monospace; margin-top:4px; }
@media (max-width:768px) {
  .sidebar { position:fixed; top:0; left:0; bottom:0; z-index:50; transform:translateX(-100%); width:280px; }
  .sidebar.mobile-open { transform:translateX(0); }
  .sidebar.collapsed { transform:translateX(-100%); }
  .chat-messages, .input-bar { padding-left:12px; padding-right:12px; }
  .msg-bubble { max-width:90%; }
  .header { padding:12px 16px; }
  .header-left h1 { font-size:16px; }
  .model-menu { min-width:200px; }
  .input-wrap { gap:4px; padding:4px 4px 4px 6px; }
  .bar-badge span { display:none; }
  .bar-badge { padding:6px; }
  .bar-model-name { max-width:90px; }
  .bar-icon-btn { width:28px; height:28px; }
  .send-btn { width:38px; height:38px; }
  .settings-layout { flex-direction:column; }
  .settings-sidebar { width:100%; height:auto; border-right:none; border-bottom:1px solid var(--border-subtle); padding:10px; display:flex; gap:6px; overflow-x:auto; }
  .settings-nav-item { width:auto; flex-shrink:0; margin-bottom:0; }
  .settings-nav-label { white-space:nowrap; }
  .settings-main { padding:20px 16px; }
}
`;

// ============================================================
// JAVASCRIPT FRONTEND
// ============================================================

const JS_FRONTEND = `
(function() {
  const state = { convId: window.DRAGON?.convId || null, model: window.DRAGON?.model || "qwen3.5-397b", streaming: false, stopRequested: false, abortCtrl: null, mode: localStorage.getItem("dragon-mode") || "full" };
  const \$ = (s) => document.querySelector(s);
  const \$\$ = (s) => document.querySelectorAll(s);
  function toast(msg, isError) { const r = \$("#toast-root"); r.innerHTML = '<div class="toast ' + (isError ? "error" : "") + '">' + msg + '</div>'; setTimeout(() => r.innerHTML = "", 2000); }
  function setSendMode(s) { const b = \$("#send-btn"); if (!b) return; if (s) { b.classList.add("stop"); b.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>'; b.title = "Arrêter"; } else { b.classList.remove("stop"); b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>'; b.title = "Envoyer"; } }
  function escapeHtml(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;"); }
  function renderMarkdown(text, mode) {
    const diffs = []; text = text.replace(/\`\`\`diff\\s*\\n([\\s\\S]*?)\`\`\`/g, (_, body) => { const b = parseDiffBody(body); if (b) { diffs.push(b); return "__DRAGON_DIFF_" + (diffs.length-1) + "__"; } return _; });
    const commands = []; text = text.replace(/\`\`\`(bash|powershell|sh|cmd|shell|ps1)\\s*\\n([\\s\\S]*?)\`\`\`/g, (_, lang, body) => { commands.push({language:lang, command:body.trim()}); return "__DRAGON_CMD_" + (commands.length-1) + "__"; });
    const escaped = escapeHtml(text);
    let out = escaped.replace(/\`\`\`(\\w*)\\n?([\\s\\S]*?)\`\`\`/g, (_, _l, c) => '<pre class="code-block"><code>' + c.trim() + '</code></pre>');
    out = out.replace(/\`([^\`]+)\`/g, '<code class="inline-code">\$1</code>');
    out = out.replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>\$1</strong>");
    out = out.replace(/\\*([^*]+)\\*/g, "<em>\$1</em>");
    out = out.replace(/^###\\s+(.+)\$/gm, '<h3 class="md-h3">\$1</h3>');
    out = out.replace(/^##\\s+(.+)\$/gm, '<h2 class="md-h2">\$1</h2>');
    out = out.replace(/^#\\s+(.+)\$/gm, '<h1 class="md-h1">\$1</h1>');
    out = out.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="\$2" target="_blank" rel="noopener" class="md-link">\$1</a>');
    out = out.split(/\\n\\n+/).map(b => b.startsWith("<") ? b : '<p>' + b.replace(/\\n/g, "<br>") + '</p>').join("\\n");
    out = out.replace(/__DRAGON_DIFF_(\\d+)__/g, (_, i) => renderDiffCard(diffs[parseInt(i,10)], parseInt(i,10)));
    out = out.replace(/__DRAGON_CMD_(\\d+)__/g, (_, i) => { const idx=parseInt(i,10); const cmd=commands[idx]; if (!cmd) return ""; if (mode === "full") return '<pre class="code-block"><code>' + escapeHtml(cmd.command) + '</code></pre>'; return renderApprovalCard(cmd, idx); });
    return out;
  }
  function parseDiffBody(body) { const lines = body.split("\\n"); let fileName="fichier"; const r=[]; for (const line of lines) { const a=line.match(/^\\+\\+\\+\\s+(?:b\\/)?(.+)$/); if (a) { fileName=a[1].trim(); continue; } if (line.startsWith("--- ")||line.startsWith("@@")||line.startsWith("diff --git")) continue; if (line.startsWith("+")) r.push({type:"add",text:line.slice(1)}); else if (line.startsWith("-")) r.push({type:"del",text:line.slice(1)}); else if (line.startsWith(" ")) r.push({type:"ctx",text:line.slice(1)}); else if (line.trim()==="") r.push({type:"ctx",text:""}); } let n=1; for (const l of r) l.num=n++; return {fileName, added:r.filter(l=>l.type==="add").length, removed:r.filter(l=>l.type==="del").length, lines:r}; }
  function renderDiffCard(b, index) { const lh=b.lines.map(l => { const c=l.type==="add"?"diff-line-add":l.type==="del"?"diff-line-del":"diff-line-ctx"; const s=l.type==="add"?"+":l.type==="del"?"−":" "; return '<div class="'+c+'"><span class="diff-line-num">'+l.num+'</span><span class="diff-line-sign">'+s+'</span><span class="diff-line-text">'+(escapeHtml(l.text)||"&nbsp;")+'</span></div>'; }).join(""); return '<div class="diff-card" data-diff-idx="'+index+'"><div class="diff-summary"><div class="diff-file-info"><span class="diff-file-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></span><span class="diff-file-name">'+escapeHtml(b.fileName)+'</span></div><div class="diff-stats"><span class="diff-stat diff-added">+'+b.added+'</span><span class="diff-stat diff-removed">−'+b.removed+'</span></div><button type="button" class="diff-review-btn" onclick="dragonToggleDiff('+index+')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg><span>Review</span></button></div><div class="diff-detail" id="diff-detail-'+index+'" style="display:none"><div class="diff-lines">'+lh+'</div></div></div>'; }
  function renderApprovalCard(cmd, index) { const arrow='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>'; return '<div class="approval-card" data-cmd-idx="'+index+'"><div class="approval-header"><span class="approval-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span><span class="approval-title">Dragon Code veut exécuter une commande. L\\'autorises-tu ?</span></div><div class="approval-command"><div class="approval-command-lang">'+escapeHtml(cmd.language)+'</div><pre class="approval-command-code"><code>'+escapeHtml(cmd.command)+'</code></pre></div><div class="approval-options"><div class="approval-option selected" data-choice="yes" onclick="dragonSelectApproval('+index+',\\'yes\\')"><span class="approval-radio">1</span><span class="approval-option-text">Oui</span></div><div class="approval-option" data-choice="no" onclick="dragonSelectApproval('+index+',\\'no\\')"><span class="approval-radio">2</span><span class="approval-option-text">Non</span></div></div><div class="approval-actions"><button type="button" class="approval-btn approval-btn-ignore" onclick="dragonIgnoreCommand('+index+')">Ignorer</button><button type="button" class="approval-btn approval-btn-submit" onclick="dragonSubmitApproval('+index+')"><span>Soumettre</span>'+arrow+'</button></div><div class="approval-hint">Appuie sur <kbd>Entrée</kbd> pour soumettre</div></div>'; }
  function scrollChat() { const a = \$("#chat-area"); if (a) a.scrollTop = a.scrollHeight; }

  window.dragonToggleSidebar = function() { \$("#sidebar").classList.toggle("collapsed"); };
  window.dragonNewChat = async function() { const r = await fetch("/api/conversations", { method: "POST" }); const c = await r.json(); window.location.href = "/c/" + c.id; };
  window.dragonLoadConv = function(id) { window.location.href = "/c/" + id; };

  async function changeModel(k, n) { state.model = k; const r = await fetch("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: k }) }); const d = await r.json(); const c = \$("#model-chip"); if (c) c.textContent = d.modelName || n; const t = \$("#toolbar-model-name"); if (t) t.textContent = d.modelName || n; \$\$(".model-option").forEach(o => { const s = o.dataset.key === k; o.classList.toggle("selected", s); const ex = o.querySelector("svg"); if (s && !ex) o.insertAdjacentHTML("beforeend", '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'); else if (!s && ex) ex.remove(); }); toast("✓ Modèle : " + (d.modelName || n)); }
  window.dragonChangeModel = changeModel;
  window.dragonToggleModelMenu = function(e) { e.stopPropagation(); \$("#model-menu").classList.toggle("open"); };
  window.dragonSelectModel = function(k, n) { changeModel(k, n); \$("#model-menu").classList.remove("open"); };
  document.addEventListener("click", (e) => { const m = \$("#model-menu"); const d = \$("#model-dropdown"); if (m && m.classList.contains("open") && d && !d.contains(e.target)) m.classList.remove("open"); });

  function applyMode(mode) {
    state.mode = mode;
    localStorage.setItem("dragon-mode", mode);
    document.cookie = "dragon-mode=" + mode + "; path=/; max-age=31536000; SameSite=Lax";
    const labels = { full: "Accès complet", approval: "Demander une approbation" };
    const icons = { full: "alert", approval: "hand" };
    const l = \$("#mode-label"); if (l) l.textContent = labels[mode] || "Accès complet";
    const i = \$("#mode-icon"); if (i) i.innerHTML = getIconHtml(icons[mode] || "alert");
    const checkHtml = '<span class="mode-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>';
    \$\$(".mode-option").forEach(o => { if (!o.querySelector(".mode-check")) o.insertAdjacentHTML("beforeend", checkHtml); const s = o.dataset.mode === mode; o.classList.toggle("selected", s); });
    document.querySelectorAll(".msg-row.assistant .msg-content").forEach(el => { const raw = el.getAttribute("data-raw-content"); if (raw) { try { const decoded = atob(raw); el.innerHTML = renderMarkdown(decoded, mode); } catch(e) {} } });
  }
  function getIconHtml(name) { const icons = { alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>', hand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0"/><path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>' }; return icons[name] || icons.alert; }
  applyMode(state.mode);
  window.dragonToggleModeMenu = function(e) { e.stopPropagation(); \$("#mode-menu").classList.toggle("open"); \$("#model-menu")?.classList.remove("open"); };
  window.dragonSelectMode = function(mode, label) { applyMode(mode); \$("#mode-menu").classList.remove("open"); toast("✓ Mode : " + label); };
  document.addEventListener("click", (e) => { const m = \$("#mode-menu"); const d = \$("#mode-dropdown"); if (m && m.classList.contains("open") && d && !d.contains(e.target)) m.classList.remove("open"); });

  window.dragonSelectApproval = function(idx, choice) { const c = document.querySelector('.approval-card[data-cmd-idx="'+idx+'"]'); if (!c) return; c.querySelectorAll(".approval-option").forEach(o => o.classList.toggle("selected", o.dataset.choice === choice)); };
  document.addEventListener("keydown", (e) => { if (e.key === "Enter") { const c = document.activeElement?.closest(".approval-card"); if (c && document.activeElement?.tagName !== "TEXTAREA" && !e.target.closest("#input-field")) { e.preventDefault(); dragonSubmitApproval(c.dataset.cmdIdx); } } });
  window.dragonSubmitApproval = function(idx) { const c = document.querySelector('.approval-card[data-cmd-idx="'+idx+'"]'); if (!c) return; const s = c.querySelector(".approval-option.selected"); const ch = s?.dataset.choice || "yes"; if (ch === "yes") { c.style.borderLeftColor = "var(--accent-green)"; c.querySelector(".approval-title").textContent = "✓ Commande exécutée avec succès"; toast("✓ Commande approuvée et exécutée"); } else { c.style.borderLeftColor = "var(--text-muted)"; c.querySelector(".approval-title").textContent = "✗ Commande refusée"; toast("✗ Commande refusée"); } const a = c.querySelector(".approval-actions"); if (a) a.style.display = "none"; const o = c.querySelector(".approval-options"); if (o) o.style.display = "none"; const h = c.querySelector(".approval-hint"); if (h) h.style.display = "none"; };
  window.dragonIgnoreCommand = function(idx) { const c = document.querySelector('.approval-card[data-cmd-idx="'+idx+'"]'); if (!c) return; c.style.opacity = "0.5"; c.style.borderLeftColor = "var(--text-muted)"; const a = c.querySelector(".approval-actions"); if (a) a.style.display = "none"; const o = c.querySelector(".approval-options"); if (o) o.style.display = "none"; const h = c.querySelector(".approval-hint"); if (h) h.style.display = "none"; c.querySelector(".approval-title").textContent = "✗ Commande ignorée"; toast("Commande ignorée"); };

  window.dragonToggleDiff = function(idx) { const d = document.getElementById("diff-detail-" + idx); if (!d) return; const o = d.style.display !== "none"; d.style.display = o ? "none" : "block"; const c = d.closest(".diff-card"); const b = c?.querySelector(".diff-review-btn span"); if (b) b.textContent = o ? "Review" : "Masquer"; };

  window.dragonSuggest = function(p) { const f = \$("#input-field"); f.value = p; dragonAutoGrow(f); f.focus(); };
  window.dragonAutoGrow = function(el) { el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 200) + "px"; };

  window.dragonSend = async function(e) {
    e.preventDefault();
    if (state.streaming) { state.stopRequested = true; if (state.abortCtrl) state.abortCtrl.abort(); return false; }
    const f = \$("#input-field"); const text = (f.value || "").trim(); if (!text) return false;
    state.streaming = true; state.stopRequested = false; setSendMode(true); f.value = ""; dragonAutoGrow(f);
    if (!state.convId) { const r = await fetch("/api/conversations", { method: "POST" }); const c = await r.json(); state.convId = c.id; }
    const w = \$(".welcome"); if (w) \$("#chat-area").innerHTML = '<div class="chat-messages" id="chat-messages"></div>';
    const m = \$("#chat-messages");
    m.insertAdjacentHTML("beforeend", '<div class="msg-row user"><div class="avatar user">U</div><div class="msg-bubble">' + escapeHtml(text) + '</div></div>');
    m.insertAdjacentHTML("beforeend", '<div class="typing" id="typing-indicator"><div class="avatar dragon">🐉</div><div class="msg-bubble"><div class="spinner"></div><span style="color:var(--text-muted);font-size:13px;font-style:italic">Dragon réfléchit...</span></div></div>');
    scrollChat();
    const ah = '<div class="msg-row assistant" id="streaming-msg"><div class="avatar dragon">🐉</div><div class="msg-bubble"><div class="msg-author">Dragon Agent</div><div class="msg-content" id="streaming-content"></div></div></div>';
    try {
      state.abortCtrl = new AbortController();
      const nimKey = localStorage.getItem("dragon-api-key") || "";
      const resp = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json", ...(nimKey ? { "X-NIM-API-Key": nimKey } : {}) }, body: JSON.stringify({ convId: state.convId, message: text, model: state.model }), signal: state.abortCtrl.signal });
      if (!resp.ok) throw new Error(await resp.text());
      const ti = \$("#typing-indicator"); if (ti) ti.remove();
      m.insertAdjacentHTML("beforeend", ah);
      const content = \$("#streaming-content"); let full = "";
      const reader = resp.body.getReader(); const decoder = new TextDecoder(); let buf = "";
      while (true) { const { done, value } = await reader.read(); if (done) break; buf += decoder.decode(value, { stream: true }); let idx; while ((idx = buf.indexOf("\\n\\n")) !== -1) { const ev = buf.slice(0, idx); buf = buf.slice(idx + 2); for (const line of ev.split("\\n")) { if (!line.startsWith("data:")) continue; const d = line.slice(5).trim(); if (d === "[DONE]") continue; try { const o = JSON.parse(d); if (o.delta) { full += o.delta; content.innerHTML = renderMarkdown(full, state.mode); scrollChat(); } if (o.error) { full += "\\n\\n❌ " + o.error; content.innerHTML = renderMarkdown(full, state.mode); } } catch {} } } }
      const fm = \$("#streaming-msg"); if (fm) fm.outerHTML = '<div class="msg-row assistant"><div class="avatar dragon">🐉</div><div class="msg-bubble"><div class="msg-author">Dragon Agent</div><div class="msg-content">' + renderMarkdown(full || "(aucune réponse)", state.mode) + '</div><div class="msg-footer"><span class="model-tag">📄 ' + state.model + '</span><span class="spacer"></span><button class="icon-btn copy-btn" data-copy-text="' + escapeHtml(full) + '" title="Copier"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button><button class="icon-btn" onclick="dragonReprompt()" title="Reprompter"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg></button></div></div></div>';
      refreshSidebar();
      if (window.location.pathname === "/") history.replaceState({}, "", "/c/" + state.convId);
    } catch (e) { const ti = \$("#typing-indicator"); if (ti) ti.remove(); const m2 = \$("#chat-messages"); if (m2) m2.insertAdjacentHTML("beforeend", '<div class="msg-row assistant"><div class="avatar dragon">🐉</div><div class="msg-bubble"><div class="msg-author">Dragon Agent</div><div class="msg-content" style="color:var(--stop-red)">❌ Erreur : ' + escapeHtml(e.message) + '</div></div></div>'); }
    finally { state.streaming = false; setSendMode(false); }
    return false;
  };

  async function refreshSidebar() { const r = await fetch("/api/conversations"); const c = await r.json(); const l = \$("#conv-list"); if (!l) return; l.innerHTML = c.map(cv => '<div class="conv-item ' + (cv.id === state.convId ? "active" : "") + '" onclick="dragonLoadConv(\\'' + cv.id + '\\')"><span class="conv-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></span><div style="flex:1;min-width:0"><div class="conv-title">' + escapeHtml(cv.title) + '</div><div class="conv-meta">' + (cv.relativeTime || "") + '</div></div><div class="conv-actions"><button class="icon-btn" onclick="event.stopPropagation();dragonRename(\\'' + cv.id + '\\',\\'' + escapeHtml(cv.title).replace(/'/g, "\\\\'") + '\\')" title="Renommer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button><button class="icon-btn" onclick="event.stopPropagation();dragonDelete(\\'' + cv.id + '\\')" title="Supprimer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button></div></div>').join(""); }

  window.dragonCopy = function(btn, text) {
    const onSuccess = () => { btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'; btn.style.color = "var(--accent-green)"; toast("✓ Copié !"); setTimeout(() => { btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'; btn.style.color = ""; }, 2000); };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(onSuccess).catch(() => fallbackCopy(text, onSuccess)); else fallbackCopy(text, onSuccess);
  };
  document.addEventListener("click", (e) => { const b = e.target.closest(".copy-btn"); if (b) { e.preventDefault(); dragonCopy(b, b.getAttribute("data-copy-text") || ""); } });
  function fallbackCopy(text, onSuccess) { try { const ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.left = "50%"; ta.style.top = "50%"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.focus(); ta.select(); const ok = document.execCommand("copy"); document.body.removeChild(ta); if (ok) onSuccess(); else showManualCopy(text); } catch (e) { showManualCopy(text); } }
  function showManualCopy(text) { \$("#modal-root").innerHTML = '<div class="modal-overlay" onclick="if(event.target===this)dragonCloseModal()"><div class="modal" style="max-width:500px"><h3 style="margin-bottom:8px">Copier le texte</h3><p style="font-size:12px;color:var(--text-muted);margin-bottom:12px">Sélectionne le texte ci-dessous et fais Ctrl+C :</p><textarea style="width:100%;min-height:120px;background:var(--bg-surface);border:1px solid var(--border);border-radius:8px;padding:10px;color:var(--text-primary);font-family:inherit;font-size:12px;resize:vertical" readonly onclick="this.select()">' + escapeHtml(text) + '</textarea><div class="modal-actions"><button class="btn btn-primary" onclick="dragonCloseModal()">Fermer</button></div></div></div>'; }

  window.dragonRename = function(id, t) { \$("#modal-root").innerHTML = '<div class="modal-overlay" onclick="if(event.target===this)dragonCloseModal()"><div class="modal"><h3>Renommer la conversation</h3><input type="text" id="rename-input" value="' + escapeHtml(t) + '" autofocus onkeydown="if(event.key===\\'Enter\\')dragonDoRename(\\'' + id + '\\')"><div class="modal-actions"><button class="btn btn-ghost" onclick="dragonCloseModal()">Annuler</button><button class="btn btn-primary" onclick="dragonDoRename(\\'' + id + '\\')">Enregistrer</button></div></div></div>'; setTimeout(() => \$("#rename-input")?.focus(), 50); };
  window.dragonDoRename = async function(id) { const v = \$("#rename-input").value.trim(); if (!v) return; await fetch("/api/conversations/" + id, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: v }) }); dragonCloseModal(); refreshSidebar(); toast("✓ Renommé"); };
  window.dragonDelete = async function(id) { if (!confirm("Supprimer cette conversation ?")) return; await fetch("/api/conversations/" + id, { method: "DELETE" }); if (id === state.convId) window.location.href = "/"; else refreshSidebar(); toast("✓ Supprimé"); };

  window.dragonReprompt = function() {
    const radios = (window.NIM_MODELS_JS || []).map(m => '<label class="radio-item"><input type="radio" name="reprompt-model" value="' + m.key + '" ' + (m.key === state.model ? "checked" : "") + '><span>' + escapeHtml(m.name) + ' <span style="color:var(--text-muted);font-size:11px">(NIM)</span></span></label>').join("");
    \$("#modal-root").innerHTML = '<div class="modal-overlay" onclick="if(event.target===this)dragonCloseModal()"><div class="modal"><h3>Reprompter avec…</h3><p style="font-size:11px;color:var(--text-muted);margin-bottom:8px;font-style:italic">Modèle actif : ' + escapeHtml(state.model) + '</p><div class="radio-list">' + radios + '</div><div class="modal-actions"><button class="btn btn-ghost" onclick="dragonCloseModal()">Annuler</button><button class="btn btn-primary" onclick="dragonDoReprompt()">Reprompter</button></div></div></div>';
  };
  window.dragonDoReprompt = async function() { const s = document.querySelector('input[name="reprompt-model"]:checked')?.value; if (!s || !state.convId) { dragonCloseModal(); return; } dragonCloseModal(); const nimKey = localStorage.getItem("dragon-api-key") || ""; const r = await fetch("/api/reprompt", { method: "POST", headers: { "Content-Type": "application/json", ...(nimKey ? { "X-NIM-API-Key": nimKey } : {}) }, body: JSON.stringify({ convId: state.convId, model: s }) }); if (r.ok) window.location.reload(); else toast("Erreur lors du reprompt", true); };
  window.dragonCloseModal = function() { \$("#modal-root").innerHTML = ""; dragonClosePage(); };

  window.dragonUpgrade = function() { toast("🚀 Bientôt disponible — Dragon Code Pro"); };
  window.dragonOpenProfileMenu = function() {
    dragonCloseProfileMenu();
    const p = document.querySelector(".sidebar-footer .profile"); if (!p) return;
    const r = p.getBoundingClientRect();
    const pi = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
    const si = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
    const ci = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
    const pop = document.createElement("div"); pop.id = "profile-popup"; pop.className = "profile-popup";
    pop.innerHTML = '<div class="profile-menu"><div class="profile-menu-header"><div class="avatar" style="width:40px;height:40px;font-size:15px">NM</div><div><div class="profile-menu-name">Naoufal</div><div class="profile-menu-plan">Plan Free</div></div></div><div class="profile-menu-items"><button class="profile-menu-item" onclick="dragonOpenProfilePage()"><span class="profile-menu-icon">' + pi + '</span><span class="profile-menu-text">Profil</span>' + ci + '</button><button class="profile-menu-item" onclick="dragonOpenSettings()"><span class="profile-menu-icon">' + si + '</span><span class="profile-menu-text">Paramètres</span>' + ci + '</button></div></div>';
    pop.style.position = "fixed"; pop.style.left = r.left + "px"; pop.style.bottom = (window.innerHeight - r.top + 8) + "px"; pop.style.zIndex = "1000";
    document.body.appendChild(pop);
    setTimeout(() => document.addEventListener("click", dragonCloseProfileMenuOnOutside), 0);
  };
  window.dragonCloseProfileMenu = function() { const p = document.getElementById("profile-popup"); if (p) p.remove(); document.removeEventListener("click", dragonCloseProfileMenuOnOutside); };
  function dragonCloseProfileMenuOnOutside(e) { const p = document.getElementById("profile-popup"); const pe = document.querySelector(".sidebar-footer .profile"); if (p && !p.contains(e.target) && pe && !pe.contains(e.target)) dragonCloseProfileMenu(); }

  window.dragonOpenProfilePage = function() {
    dragonCloseProfileMenu();
    \$("#page-root").innerHTML = '<div class="page-fullscreen"><div class="page-header"><button class="icon-btn page-back-btn" onclick="dragonClosePage()" title="Fermer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button><h2>Profil</h2></div><div class="page-content"><div class="profile-avatar-large"><div class="avatar" style="width:96px;height:96px;font-size:36px">NM</div></div><div class="settings-section"><label class="settings-label">Nom</label><input type="text" class="settings-input" value="Naoufal" id="profile-name-input"></div><div class="settings-section"><label class="settings-label">Email</label><input type="text" class="settings-input" value="naoufal@example.com" id="profile-email-input"></div><div class="settings-section"><label class="settings-label">Plan</label><div class="settings-plan-row"><span class="settings-plan-badge">Free</span><button class="upgrade-chip" onclick="dragonUpgrade()">Mettre à niveau</button></div></div><div class="page-actions"><button class="btn btn-primary" onclick="dragonSaveProfile()">Enregistrer</button></div></div></div>';
  };
  window.dragonSaveProfile = function() { const n = \$("#profile-name-input")?.value || "Naoufal"; document.querySelectorAll(".profile-name").forEach(e => e.textContent = n); const i = n.substring(0, 2).toUpperCase(); document.querySelectorAll(".avatar").forEach(e => { if (!e.classList.contains("dragon") && !e.classList.contains("user")) e.textContent = i; }); dragonClosePage(); toast("✓ Profil enregistré"); };

  window.dragonOpenSettings = function() {
    dragonCloseProfileMenu();
    const ci = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    const k = localStorage.getItem("dragon-api-key") || "";
    const mi = [{id:"api",label:"Clé API",icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>'},{id:"model",label:"Modèle par défaut",icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>'},{id:"mode",label:"Mode d'accès",icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>'},{id:"data",label:"Données",icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>'},{id:"about",label:"À propos",icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'}];
    \$("#page-root").innerHTML = '<div class="page-fullscreen"><div class="page-header"><button class="icon-btn page-back-btn" onclick="dragonClosePage()" title="Fermer">' + ci + '</button><h2>Paramètres</h2></div><div class="settings-layout"><aside class="settings-sidebar">' + mi.map((m, i) => '<button class="settings-nav-item ' + (i === 0 ? "active" : "") + '" data-section="' + m.id + '" onclick="dragonSwitchSettingsSection(\\'' + m.id + '\\')"><span class="settings-nav-icon">' + m.icon + '</span><span class="settings-nav-label">' + m.label + '</span></button>').join("") + '</aside><div class="settings-main"><div class="settings-section-content" id="section-api" style="display:block"><h3 class="section-title">Clé API NVIDIA NIM</h3><div class="settings-section"><label class="settings-label">Clé API</label><input type="password" class="settings-input" placeholder="nvapi-..." value="' + k + '" id="settings-api-key"><div class="settings-hint">Ta clé API pour accéder aux modèles NVIDIA NIM. Stockée localement uniquement.</div></div><div class="settings-section"><label class="settings-label">Comment obtenir une clé ?</label><div class="settings-hint">1. Va sur <a href="https://build.nvidia.com" target="_blank" class="md-link">build.nvidia.com</a><br>2. Crée un compte gratuit<br>3. Génère une clé API (format <code class="inline-code">nvapi-...</code>)<br>4. Colle-la ci-dessus</div></div></div><div class="settings-section-content" id="section-model" style="display:none"><h3 class="section-title">Modèle par défaut</h3><div class="settings-section"><label class="settings-label">Modèle</label><select class="settings-input settings-select" id="settings-default-model">' + (window.NIM_MODELS_JS || []).map(m => '<option value="' + m.key + '" ' + (m.key === state.model ? "selected" : "") + '>' + m.name + '</option>').join("") + '</select><div class="settings-hint">Le modèle utilisé par défaut au démarrage.</div></div><div class="settings-section"><label class="settings-label">Modèles disponibles</label><div class="settings-models-list">' + (window.NIM_MODELS_JS || []).map(m => '<div class="settings-model-item ' + (m.key === state.model ? "current" : "") + '"><span class="settings-model-name">' + m.name + '</span><span class="settings-model-tag">NIM</span>' + (m.key === state.model ? '<span class="settings-model-current">Actuel</span>' : "") + '</div>').join("") + '</div></div></div><div class="settings-section-content" id="section-mode" style="display:none"><h3 class="section-title">Mode d\\'accès</h3><div class="settings-section"><label class="settings-label">Mode par défaut</label><select class="settings-input settings-select" id="settings-default-mode"><option value="full" ' + (state.mode === "full" ? "selected" : "") + '>Accès complet</option><option value="approval" ' + (state.mode === "approval" ? "selected" : "") + '>Demander une approbation</option></select><div class="settings-hint">Comment Dragon Code gère les commandes.</div></div><div class="settings-section"><label class="settings-label">Description des modes</label><div class="settings-mode-desc"><div class="settings-mode-item"><div class="settings-mode-name">⚠️ Accès complet</div><div class="settings-mode-text">L\\'IA exécute les commandes sans demander. Plus rapide mais moins sécurisé.</div></div><div class="settings-mode-item"><div class="settings-mode-name">✋ Demander une approbation</div><div class="settings-mode-text">L\\'IA demande ta permission avant chaque commande. Plus sûr.</div></div></div></div></div><div class="settings-section-content" id="section-data" style="display:none"><h3 class="section-title">Données</h3><div class="settings-section"><label class="settings-label">Conversations</label><button class="btn btn-danger" onclick="dragonClearData()">Effacer toutes les conversations</button><div class="settings-hint">Supprime définitivement toutes tes conversations et messages.</div></div><div class="settings-section"><label class="settings-label">Cache</label><button class="btn btn-ghost" onclick="dragonClearCache()">Vider le cache</button><div class="settings-hint">Vide le localStorage (clé API, préférences, etc.).</div></div></div><div class="settings-section-content" id="section-about" style="display:none"><h3 class="section-title">À propos</h3><div class="settings-about-card"><div class="settings-about-logo">🐉</div><div class="settings-about-name">Dragon Code</div><div class="settings-about-version">Version 1.0</div><div class="settings-about-desc">Assistant de code IA propulsé par NVIDIA NIM</div><div class="settings-about-tech">TypeScript + Bun + SQLite</div></div></div><div class="page-actions"><button class="btn btn-primary" onclick="dragonSaveSettings()">Enregistrer</button></div></div></div></div>';
  };
  window.dragonSwitchSettingsSection = function(id) { document.querySelectorAll(".settings-nav-item").forEach(b => b.classList.toggle("active", b.dataset.section === id)); document.querySelectorAll(".settings-section-content").forEach(s => s.style.display = s.id === "section-" + id ? "block" : "none"); };
  window.dragonClearCache = function() { if (!confirm("Vider le cache ?")) return; const m = localStorage.getItem("dragon-mode"); const mo = localStorage.getItem("dragon-model"); localStorage.clear(); if (m) localStorage.setItem("dragon-mode", m); if (mo) localStorage.setItem("dragon-model", mo); toast("✓ Cache vidé"); dragonClosePage(); setTimeout(() => window.location.reload(), 500); };
  window.dragonSaveSettings = function() { const k = \$("#settings-api-key")?.value?.trim() || ""; const dm = \$("#settings-default-model")?.value; const dmo = \$("#settings-default-mode")?.value; localStorage.setItem("dragon-api-key", k); if (dm) changeModel(dm); if (dmo) applyMode(dmo); dragonClosePage(); toast("✓ Paramètres enregistrés"); };
  window.dragonClearData = async function() { if (!confirm("Supprimer DÉFINITIVEMENT toutes les conversations ?")) return; const c = await fetch("/api/conversations").then(r => r.json()); for (const cv of c) await fetch("/api/conversations/" + cv.id, { method: "DELETE" }); dragonClosePage(); toast("✓ Toutes les conversations supprimées"); setTimeout(() => window.location.reload(), 500); };
  window.dragonClosePage = function() { const p = document.getElementById("page-root"); if (p) p.innerHTML = ""; };

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "n") { e.preventDefault(); dragonNewChat(); }
    if ((e.ctrlKey || e.metaKey) && e.key === "k") { e.preventDefault(); document.getElementById("input-field")?.focus(); }
    if (e.key === "Enter" && !e.shiftKey && document.activeElement?.id === "input-field") { e.preventDefault(); document.getElementById("input-form")?.requestSubmit(); }
  });

  console.log("🐉 Dragon Code prêt — conv:", state.convId, "model:", state.model, "mode:", state.mode);
})();
`;

// ============================================================
// SERVEUR HTTP (HONO)
// ============================================================

const app = new Hono();

function getModelFromCtx(c: any): string {
  const cookie = c.req.header("cookie") || "";
  const match = cookie.match(/dragon-model=([^;]+)/);
  return match ? match[1] : "qwen3.5-397b";
}

function setModelCookie(c: any, model: string) {
  c.header("Set-Cookie", `dragon-model=${model}; Path=/; Max-Age=31536000; SameSite=Lax`);
}

app.get("/", (c) => {
  const model = getModelFromCtx(c);
  const convs = listConversations();
  return c.html(layout(welcome(model), model, null, convs));
});

app.get("/c/:id", (c) => {
  const id = c.req.param("id");
  const conv = getConversation(id);
  if (!conv) return c.redirect("/");
  const model = getModelFromCtx(c);
  const messages = listMessages(id);
  return c.html(layout(chatArea(messages, model), model, id, listConversations()));
});

app.get("/api/models", (c) => c.json(NIM_MODELS));

app.post("/api/session", async (c) => {
  const data = await c.req.json();
  if (data?.model) setModelCookie(c, data.model);
  return c.json({ model: data.model, modelName: getModel(data.model).name });
});

app.get("/api/conversations", (c) => {
  const convs = listConversations();
  return c.json(convs.map((cv) => ({ ...cv, relativeTime: relativeTime(cv.updated_at) })));
});

app.post("/api/conversations", (c) => c.json(createConversation()));

app.patch("/api/conversations/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  if (!body?.title?.trim()) return c.json({ error: "title required" }, 400);
  renameConversation(id, body.title.trim());
  return c.json({ ok: true });
});

app.delete("/api/conversations/:id", (c) => {
  deleteConversation(c.req.param("id"));
  return c.json({ ok: true });
});

app.post("/api/chat", async (c) => {
  const body = await c.req.json();
  const { convId, message, model } = body as { convId: string; message: string; model: string };
  if (!convId || !message) return c.json({ error: "convId and message required" }, 400);
  const conv = getConversation(convId);
  if (!conv) return c.json({ error: "conversation not found" }, 404);
  if (conv.title === "Nouveau Chat") renameConversation(convId, makeTitle(message));
  addMessage(convId, "user", message);
  const apiMessages = getMessagesForApi(convId);
  const clientApiKey = c.req.header("X-NIM-API-Key");
  c.header("Content-Type", "text/event-stream; charset=utf-8");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      let fullResponse = "";
      try {
        for await (const delta of streamChat(model, apiMessages, clientApiKey)) {
          fullResponse += delta;
          send({ delta });
        }
        if (!fullResponse.trim()) send({ error: "Aucune reponse recue du modele. Verifie ta cle API NVIDIA NIM, le modele selectionne, puis reessaie." });
        send({ done: true });
        if (fullResponse) addMessage(convId, "assistant", fullResponse, model);
      } catch (e) {
        send({ error: (e as Error).message });
      } finally {
        controller.close();
      }
    },
  });
  return c.body(stream);
});

app.post("/api/reprompt", async (c) => {
  const body = await c.req.json();
  const { convId, model } = body as { convId: string; model: string };
  if (!convId) return c.json({ error: "convId required" }, 400);
  removeLastAssistantMessage(convId);
  const apiMessages = getMessagesForApi(convId);
  if (apiMessages.length === 0) return c.json({ error: "no messages" }, 400);
  const clientApiKey = c.req.header("X-NIM-API-Key");
  c.header("Content-Type", "text/event-stream; charset=utf-8");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      let fullResponse = "";
      try {
        for await (const delta of streamChat(model, apiMessages, clientApiKey)) {
          fullResponse += delta;
          send({ delta });
        }
        if (!fullResponse.trim()) send({ error: "Aucune reponse recue du modele. Verifie ta cle API NVIDIA NIM, le modele selectionne, puis reessaie." });
        send({ done: true });
        if (fullResponse) addMessage(convId, "assistant", fullResponse, model);
      } catch (e) {
        send({ error: (e as Error).message });
      } finally {
        controller.close();
      }
    },
  });
  return c.body(stream);
});

app.notFound((c) => c.redirect("/"));

// ============================================================
// DÉMARRAGE
// ============================================================

const port = parseInt(process.env.PORT || "3000", 10);
const apiKey = process.env.NVIDIA_NIM_API_KEY ?? "";
const keyOk = apiKey && apiKey !== "nvapi-votre-cle-ici" && apiKey.startsWith("nvapi-");

console.log(`\n🐉  Dragon Code démarré sur http://localhost:${port}`);
console.log(`   Runtime : Bun ${Bun.version}`);
console.log(`   DB      : ./dragon.db (SQLite native)`);
console.log(`   NIM key : ${keyOk ? "✓ configurée (" + apiKey.length + " chars)" : "⚠️  manquante — configure ta clé via l'interface (Profil → Paramètres → Clé API)"}\n`);

Bun.serve({
  port,
  fetch: app.fetch,
  error(err) {
    console.error("❌ Server error:", err);
    return new Response("Internal Server Error", { status: 500 });
  },
});

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1 << 30);
