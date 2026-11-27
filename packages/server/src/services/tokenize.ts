// Chinese-aware tokenization for Postgres full-text search (server/server/services/tokenize.py).
// Uses @node-rs/jieba (verified 100% segment-for-segment identical to Python jieba 0.42.1 in P0).
import { Jieba } from "@node-rs/jieba";
import { dict as defaultDict } from "@node-rs/jieba/dict.js";

const PUNCT_RE =
  /[\s\u3000]+|[.,;:!?\-_/\\()[\]{}"'`~@#$%^&*+=<>|]+|[，。？！、；：“”‘’（）【】《》〈〉「」『』…—～·]+/;

const STOPWORDS = new Set(
  (
    "的 了 吗 呢 吧 啊 呀 么 是 在 有 和 与 及 或 就 都 也 还 又 把 被 给 让 对 从 到 为 以 于 之 " +
    "这 那 这个 那个 这些 那些 哪 哪个 哪些 哪里 什么 啥 怎么 怎样 怎么样 如何 为什么 为何 是否 多少 几 " +
    "一下 一些 一个 我 我们 你 你们 他 她 它 他们 自己 具体 那天 当时 时候 那次 这次 上次 之前 以后 " +
    "可以 能 会 要 需要 应该 没有 不 没 用 做 弄 搞 下 上 里 呢 吗 请问 帮 帮我 " +
    "the a an of to in for on with is are was were be been how what why which when where who " +
    "do does did i my me we our you your it its this that these those"
  ).split(" "),
);

export const MAX_INPUT_CHARS = 200_000;
export const MAX_TOKENS_INDEX = 50_000;
export const MAX_QUERY_TOKENS = 16;

let jiebaInst: Jieba | null = null;
function getJieba(): Jieba {
  return (jiebaInst ??= Jieba.withDict(defaultDict));
}

function segment(text: string): string[] {
  if (!text) return [];
  const jb = getJieba();
  const tokens: string[] = [];
  for (const piece of text.split(PUNCT_RE)) {
    if (!piece) continue;
    for (const tok of jb.cutForSearch(piece, true)) tokens.push(tok);
  }
  return tokens;
}

function normalize(tok: string): string {
  const t = tok.trim().toLowerCase();
  if (t.length === 1 && t.charCodeAt(0) < 128) return "";
  return t;
}

export function tokenizeForIndex(text: string): string {
  const capped = text && text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text || "";
  const out: string[] = [];
  for (const tok of segment(capped)) {
    const n = normalize(tok);
    if (n) out.push(n);
    if (out.length >= MAX_TOKENS_INDEX) break;
  }
  return out.join(" ");
}

export function queryTerms(text: string): string[] {
  const seen: string[] = [];
  const seenSet = new Set<string>();
  for (const tok of segment(text || "")) {
    const n = normalize(tok);
    if (!n || STOPWORDS.has(n) || seenSet.has(n)) continue;
    seen.push(n);
    seenSet.add(n);
    if (seen.length >= MAX_QUERY_TOKENS) break;
  }
  return seen;
}

export function tokenizeForQuery(text: string): string {
  return queryTerms(text).join(" & ");
}
