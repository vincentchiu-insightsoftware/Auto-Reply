/** 文字規則：句子切分、長度計算、正規化。全部以 Unicode code point 計。 */

const SENTENCE_END = /[。！？!?\n]+/;

export function splitSentences(text: string): string[] {
  return text
    .split(SENTENCE_END)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 不含空白的 code point 數 */
export function countChars(text: string): number {
  let n = 0;
  for (const ch of text) if (!/\s/.test(ch)) n++;
  return n;
}

export function normalize(text: string): string {
  return Array.from(text.toLowerCase())
    .filter((ch) => !/[\s。，、！？!?,.;:；：「」『』()（）]/.test(ch))
    .join('');
}

export const FORBIDDEN_FORMAT = /[*#`>•—–]|^\s*[-*]\s|```|根據截圖|根據圖片|依據畫面分析/m;

/** 宣稱真人的句型。角色第一人稱講遊戲感受不在此列。 */
export const HUMAN_CLAIM =
  /(我|本人)(是|就是|當然是|絕對是)(真人|人類|活人)|我(不是|才不是|又不是)(ai|AI|機器人|程式|人工智慧|bot)|我是真的人/i;

/** 身分提問：不回覆、不撒謊。只擋明顯問句；「這遊戲有AI嗎」這類談論遊戲的句子不擋。 */
const ID_TERMS = '(ai|a\\.i\\.|機器人|人工智慧|人工智能|bot|robot|程式|真人|人類|虛擬人|虛擬|vtuber|合成|語音合成|tts|電腦|自動(播|化)?)';
export const IDENTITY_QUESTION = new RegExp(
  `(你|妳|這|這個|主播|主持|講話的|說話的)?\\s*(是不是|是唔是|係唔係|是|係|算不算|算|會不會是|難道是|其實是|根本是)\\s*(一個|個|真的|真的是)?\\s*${ID_TERMS}` +
  `|(你|妳|是|係|這)\\s*(一個|個)?\\s*${ID_TERMS}\\s*(嗎|吗|\\?|？|嘛|吧|喔|哦|逆|齁|對吧|是吧|在講話|在說話|在玩|在播)` +
  `|are you (a |an |really a |actually a |even )?(ai|bot|robot|human|real( person)?|vtuber|a computer)` +
  `|is (this|that|it) (a |an )?(ai|bot|robot|recording|prerecorded|pre-recorded)`,
  'i',
);

/** 指令注入的粗篩。只擋明顯樣式，語意判斷留給模型與人工檢查。 */
export const INJECTION =
  /忽略(所有|之前|上面|以上)?(的)?(規則|指令|設定)|讀出(你的)?(提示|系統|prompt)|(打開|開啟|進入|點)(這個|此|下面)?(網址|連結|link|url)|執行(指令|命令|程式|腳本)|ignore (all |previous |the )?(rules|instructions)|system prompt|你現在是|從現在開始你是|改成(另一個)?角色|讀出密碼|把金鑰|api key/i;
