/**
 * 扩展内所有模块共享的契约。
 *
 * 设计原则：**分析结论必须可追溯**。
 * 每一项判断都要能指回原文（quote）或者某条检索资料（evidence），
 * 否则用户没法判断模型在胡说。
 */

/** 用户划选的原文 + 出处。 */
export interface AnalysisInput {
  text: string;
  /** 划选所在页面（只用于展示，不参与判断） */
  pageUrl?: string;
  pageTitle?: string;
}

/**
 * 这一条记录是干什么的。
 *
 * - `verify`：分析正误（原来的功能）
 * - `polish`：美化表达（去掉情绪化说法，还原实际含义）
 *
 * 老记录没有这个字段，一律当 `verify` 处理。
 */
export type AnalysisKind = 'verify' | 'polish';

/**
 * 「美化」的结果。
 *
 * 目标不是把话说得好听，而是**把话说清楚**：
 * 情绪化的说法去掉之后，主张还是那个主张，但不再带情绪。
 */
export interface PolishResult {
  /** 原文的情绪基调（一句话） */
  tone: string;
  /** 情绪化用词清单：原文照抄 + 为什么算情绪化 */
  emotional: { word: string; why: string }[];
  /** 去掉情绪后，这段话实际在主张什么 */
  meaning: string;
  /** 去掉情绪化表达后的版本（可以直接拿去用） */
  rewritten: string;
  /**
   * 改写版里**还留着**的情绪化表达。
   *
   * 为什么要有这个字段：模型偶尔会一边把「恶心人」列进情绪用词、
   * 一边把「恶心人」原样留在改写版里——这属于**自相矛盾**，
   * 而且可以在本地确定性地查出来（见 polish.ts 的 findLeftoverEmotional）。
   * 查出来就带着它重写一次；还改不掉就如实告诉用户。
   */
  leftover?: string[];
}

/** 这段文字属于哪一类。 */
export type StatementKind =
  | 'argument' // 论证：有主张也有理由
  | 'claim' // 断言：只有主张没有理由
  | 'question' // 设问
  | 'opinion' // 主观感受
  | 'ad' // 广告/带货
  | 'emotion' // 情绪表达
  | 'other';

/** 一条被主张出来的说法。 */
export interface CoreClaim {
  /** 原文摘录 */
  text: string;
  /** 这条主张本身的把握程度 */
  confidence: '高' | '中' | '低';
}

/** 一处可能的逻辑问题。 */
export interface LogicIssue {
  /** 出问题的原文片段 */
  quote: string;
  /** 问题类型（滑坡、稻草人、诉诸权威……） */
  type: string;
  /** 为什么这是问题 */
  explanation: string;
}

/** 第一阶段：结构解析 + 逻辑问题 + 检索词。 */
export interface Pass1Result {
  kind: StatementKind;
  /** 这段话在说什么（一句话） */
  summary: string;
  claims: CoreClaim[];
  logicIssues: LogicIssue[];
  /** 默认成立但没说出口的前提 */
  assumptions: string[];
  /** 要判断真伪还缺什么证据 */
  missingEvidence: string[];
  /** 用于深度搜索的检索词 */
  queries: string[];
}

/** 一条检索结果。 */
export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  /** 来自哪条检索词 */
  query: string;
}

/** 最终结论：三选一，不许骑墙。 */
export type Verdict = 'likely_true' | 'likely_false' | 'uncertain';

/** 第二阶段：结合检索资料后的公正分析。 */
export interface Pass2Result {
  verdict: Verdict;
  /** 0-1 */
  confidence: number;
  /** 给人看的一句话结论 */
  verdictText: string;
  /** 分析正文 */
  analysis: string;
  /** 有支撑的部分 */
  supported: { point: string; evidence: string }[];
  /** 存疑的部分 */
  challenged: { point: string; evidence: string }[];
  /** 证据没覆盖、无法判断的点 */
  notCovered: string[];
  /** 值得继续查的问题 */
  followUps: string[];
}

/** 一次完整分析的存档（结果页与历史都读它）。 */
export interface AnalysisRecord {
  id: string;
  createdAt: string;
  /** 这一条是「分析正误」还是「美化表达」。老记录没这个字段，当 verify 处理。 */
  kind?: AnalysisKind;
  input: AnalysisInput;
  pass1: Pass1Result | null;
  search: {
    hits: SearchHit[];
    queries: string[];
    /** 搜索失败时的原因（前端要如实显示，不能装作没搜过） */
    error?: string;
  };
  pass2: Pass2Result | null;
  /** 「美化」的结果。只有 kind='polish' 时有。 */
  polish?: PolishResult | null;
  /** 整体失败原因 */
  error?: string;
}

/** LLM 配置（用户自带 Key）。 */
export interface LlmConfig {
  provider: 'openai' | 'anthropic';
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** 单次请求的最大输出 token。推理模型要留够思考空间。 */
  maxTokens?: number;
  /**
   * 推理强度。
   *
   * 实测 MiniMax-M3.1 强制 adaptive thinking，`none` 会被 400 拒绝；
   * 而 `low` 相比默认能快一个数量级（4.8s vs 20-70s），质量没有明显差别。
   */
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
  /** 有的服务商用 max_completion_tokens 而不是 max_tokens */
  useMaxCompletionTokens?: boolean;
}

/** 扩展设置。 */
export interface Settings {
  llm: LlmConfig;
  /** 要不要做深度搜索 */
  enableSearch: boolean;
  /** 每次搜索最多取几条结果 */
  maxSearchResults: number;
  /** 历史保留多少条 */
  historyLimit: number;
}
