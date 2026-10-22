/**
 * 存储键与各项上限。
 *
 * 这个文件是「本机存了什么」的唯一来源——要清数据、要看隐私范围，都看这里。
 */
export const STORAGE_KEYS = {
  /** 设置（含 API Key） */
  settings: 'settings',
  /** 分析历史 */
  history: 'history',
} as const;

/** 单次划词文本的长度上限。超了截断——不然是误选整页。 */
export const MAX_INPUT_CHARS = 4000;

/** 一次深度搜索最多取几条结果。 */
export const MAX_SEARCH_HITS = 8;

/** 一次分析最多发几条检索词。 */
export const MAX_SEARCH_QUERIES = 3;

/** 送给 LLM 的检索结果摘要长度上限（控制 token）。 */
export const MAX_HIT_SNIPPET_CHARS = 300;

/** 历史保留条数上限。 */
export const MAX_HISTORY = 30;

/**
 * 检索词长度上限。
 *
 * 实测 Bing 的 RSS 接口对**过长的中文查询会截断**：
 * 「人工智能取代人类工作」（10 字）只匹配到「人工」，
 * 「新能源汽车补贴政策」（9 字）却正常。
 * 所以检索词要短——短关键词既准又稳。
 */
export const MAX_QUERY_CHARS = 24;

/** 搜索引擎入口。 */
export const SEARCH_ENDPOINT = 'https://www.bing.com/search';
