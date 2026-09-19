/**
 * judge.js — osu!mania 準拠の判定・スコア・Accuracy 計算（DOM 非依存 = テスト可能）。
 *
 * 判定窓 (ms)      : Perfect ±34 / Great ±67 / Good ±97 / Meh ±122 / Miss それ以外
 * Accuracy (osu!mania) :
 *   (300*Perfect + 200*Great + 100*Good + 50*Meh + 0*Miss) / (300 * 総判定数) * 100
 *   ロングノーツは「ヘッド + テイル」の 2 判定として数えます（osu! 同様、各判定の満点は 300）。
 * Score (max 1,000,000) :
 *   1,000,000 * Σ(重み) / 総判定数    重み = Perfect 1 / Great 0.75 / Good 0.5 / Meh 0.25 / Miss 0
 *   → オール Perfect でちょうど 1,000,000 点。
 */

export const MAX_SCORE = 1000000;

export const WINDOWS = Object.freeze({ perfect: 34, great: 67, good: 97, meh: 122 });

/** osu!mania のヒットサウンド/判定値に対応 */
export const ACC_VALUE = Object.freeze({ perfect: 300, great: 200, good: 100, meh: 50, miss: 0 });

export const SCORE_WEIGHT = Object.freeze({ perfect: 1, great: 0.75, good: 0.5, meh: 0.25, miss: 0 });

export const JUDGE_ORDER = Object.freeze(['perfect', 'great', 'good', 'meh', 'miss']);

export const JUDGE_LABEL = Object.freeze({
  perfect: 'PERFECT', great: 'GREAT', good: 'GOOD', meh: 'MEH', miss: 'MISS',
});

/** 絶対誤差(ms) → 判定名。窓の外なら null */
export function judgeFor(absErr, w = WINDOWS) {
  if (absErr <= w.perfect) return 'perfect';
  if (absErr <= w.great) return 'great';
  if (absErr <= w.good) return 'good';
  if (absErr <= w.meh) return 'meh';
  return null;
}

/** Accuracy (%) → ランク */
export function rankFor(acc, counts) {
  if (acc >= 100 || (counts.great === 0 && counts.good === 0 && counts.meh === 0 && counts.miss === 0)) return 'SS';
  if (acc >= 95) return 'S';
  if (acc >= 90) return 'A';
  if (acc >= 80) return 'B';
  if (acc >= 70) return 'C';
  return 'D';
}

export class Judge {
  /**
   * @param {{columns:number, notes:Array}} field ミラー適用済みのレーン情報
   * @param {typeof WINDOWS} [windows]
   */
  constructor(field, windows = WINDOWS) {
    this.w = windows;
    this.columns = field.columns;
    this.notes = field.notes;
    this.cols = [];
    for (let i = 0; i < this.columns; i++) this.cols.push([]);
    for (const n of this.notes) {
      const c = n.col >= 0 && n.col < this.columns ? n.col : 0;
      this.cols[c].push(n);
    }
    for (const list of this.cols) list.sort((a, b) => a.time - b.time || a.endTime - b.endTime);
    this.total = this.notes.reduce((s, n) => s + (n.isLN ? 2 : 1), 0);
    this.reset();
  }

  reset() {
    for (const n of this.notes) {
      n.state = 'idle';
      n.headJudge = null; n.tailJudge = null;
      n.headErr = 0; n.tailErr = 0;
      n.dropped = false; n.autoComplete = false;
    }
    this.ptr = this.cols.map(() => 0);
    this.counts = { perfect: 0, great: 0, good: 0, meh: 0, miss: 0 };
    this.accSum = 0;
    this.judged = 0;
    this.rawScore = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.errSum = 0;
    this.errCount = 0;
    this.early = 0;
    this.late = 0;
    this.events = [];
  }

  /** 現在のスコア (0〜1,000,000) */
  get score() {
    return this.total ? Math.round((MAX_SCORE * this.rawScore) / this.total) : 0;
  }

  /** osu!mania 準拠 Accuracy (%) */
  get accuracy() {
    return this.judged ? (this.accSum / (ACC_VALUE.perfect * this.judged)) * 100 : 100;
  }

  get averageError() {
    return this.errCount ? this.errSum / this.errCount : 0;
  }

  get isFinished() {
    return this.judged >= this.total;
  }

  /** 毎フレーム呼ぶ。期限切れノーツの Miss / LN の自動完了を処理してイベントを返す */
  update(t) {
    const out = [];
    const w = this.w;
    for (let c = 0; c < this.cols.length; c++) {
      const list = this.cols[c];
      let i = this.ptr[c];
      while (i < list.length) {
        const n = list[i];
        if (n.state === 'idle') {
          if (t > n.time + w.meh) {
            this._apply(n, 'head', 'miss', t - n.time);
            out.push({ note: n, col: c, part: 'head', judge: 'miss', error: t - n.time, time: t });
            if (n.isLN) {
              this._apply(n, 'tail', 'miss', t - n.endTime);
              out.push({ note: n, col: c, part: 'tail', judge: 'miss', error: t - n.endTime, time: t });
            }
            n.state = 'done';
            i++;
            continue;
          }
          break; // これ以降はもっと未来
        }
        if (n.state === 'holding') {
          if (t >= n.endTime + w.meh) {
            // 最後まで押さえきった → テイル Perfect（osu! と同じ扱い）
            this._apply(n, 'tail', 'perfect', 0);
            n.autoComplete = true;
            out.push({ note: n, col: c, part: 'tail', judge: 'perfect', error: 0, time: t });
            n.state = 'done';
            i++;
            continue;
          }
          break;
        }
        i++; // 'done'
      }
      this.ptr[c] = i;
    }
    return out;
  }

  /** キー押下。窓内の最古ノーツを判定してイベントを返す（無ければ null） */
  press(col, t) {
    const list = this.cols[col];
    if (!list) return null;
    const w = this.w;
    const hi = t + w.meh;
    const lo = t - w.meh;
    for (let i = this.ptr[col]; i < list.length; i++) {
      const n = list[i];
      if (n.time > hi) break;
      if (n.state !== 'idle' || n.time < lo) continue;
      const err = t - n.time;
      const j = judgeFor(Math.abs(err), w);
      if (!j) continue;
      this._apply(n, 'head', j, err);
      n.state = n.isLN ? 'holding' : 'done';
      n.holdStart = t;
      return { note: n, col, part: 'head', judge: j, error: err, time: t };
    }
    return null;
  }

  /** キー離散。保持中の LN テイルを判定してイベントを返す（無ければ null） */
  release(col, t) {
    const list = this.cols[col];
    if (!list) return null;
    const w = this.w;
    for (let i = this.ptr[col]; i < list.length; i++) {
      const n = list[i];
      if (n.state === 'holding') {
        const err = t - n.endTime;
        let j;
        if (err < -w.meh) { j = 'miss'; n.dropped = true; }
        else j = judgeFor(Math.abs(err), w) || 'meh';
        this._apply(n, 'tail', j, err);
        n.state = 'done';
        return { note: n, col, part: 'tail', judge: j, error: err, time: t };
      }
      if (n.state === 'idle' && n.time > t + w.meh) break;
    }
    return null;
  }

  _apply(note, part, judge, err) {
    this.counts[judge]++;
    this.judged++;
    this.accSum += ACC_VALUE[judge];
    this.rawScore += SCORE_WEIGHT[judge];
    if (judge === 'miss') {
      this.combo = 0;
    } else {
      this.combo++;
      if (this.combo > this.maxCombo) this.maxCombo = this.combo;
      this.errSum += err;
      this.errCount++;
      if (err < 0) this.early++; else this.late++;
    }
    if (part === 'head') { note.headJudge = judge; note.headErr = err; }
    else { note.tailJudge = judge; note.tailErr = err; }
  }
}
