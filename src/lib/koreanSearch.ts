// 한글 친화 검색 — es-hangul 기반.
//
// "비슷하게 쳐도" 검색되도록 네 가지 매칭을 점수화해서 합친다:
//   1) 원문 부분일치        "자이"        → 반포자이      (가장 강함)
//   2) 초성 일치            "ㄱㅎㄱ"      → 경희궁
//   3) 자모 부분일치        "경희궁자"    → 경희궁자이    (마지막 글자 미완성 대응)
//   4) 자모 편집거리(오타)  "레미안"      → 래미안        (모음/받침 한 끗 차이)
//
// scoreMatch 는 0(불일치) 또는 양수(클수록 좋음) 를 돌려준다.

import { disassemble, getChoseong } from "es-hangul";

const CHOSEONG_ONLY = /^[ㄱ-ㅎ]+$/;

export type SearchDoc = {
  raw: string; // 소문자·공백 제거 원문
  jamo: string; // 완전 분해된 자모열
  choseong: string; // 초성열
};

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, "");
}

export function buildSearchDoc(text: string): SearchDoc {
  const raw = normalize(text);
  return { raw, jamo: disassemble(raw), choseong: getChoseong(raw) };
}

// 근사 부분일치 거리: query 를 text 의 "어느 위치에서든" 부분문자열로 봤을 때
// 필요한 최소 편집 수. 첫 행을 0 으로 두어(=어디서 시작해도 비용 0) 부분일치를
// 허용한다. 행 최소값이 max 를 넘으면 즉시 포기. O(|query| * |text|).
function approxSubstringDistance(query: string, text: string, max: number): number {
  const lq = query.length;
  const lt = text.length;
  if (lq === 0) return 0;
  let prev = new Array(lt + 1).fill(0); // query 가 text 어느 지점에서든 시작 가능
  let curr = new Array(lt + 1);
  for (let i = 1; i <= lq; i += 1) {
    curr[0] = i; // text 를 0글자 쓰면 query i글자 전부 삭제
    let rowMin = curr[0];
    for (let j = 1; j <= lt; j += 1) {
      const cost = query[i - 1] === text[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    [prev, curr] = [curr, prev];
  }
  let best = max + 1;
  for (let j = 0; j <= lt; j += 1) if (prev[j] < best) best = prev[j];
  return best;
}

/**
 * 질의어 query 와 후보 문서 doc 의 일치 점수. 0 이면 불일치.
 * nameDoc 은 단지명, regionRaw 는 "구+동" 정규화 문자열(부분일치용).
 */
export function scoreMatch(query: SearchDoc, nameDoc: SearchDoc, regionRaw: string): number {
  const q = query.raw;
  if (!q) return 0;

  // 1) 원문 부분일치 — 맨 앞에서 시작하면 가점
  const rawIdx = nameDoc.raw.indexOf(q);
  if (rawIdx === 0) return 1000;
  if (rawIdx > 0) return 850 - rawIdx;

  // 구/동 부분일치 ("강남구", "역삼동" 으로 동네 단지 훑기)
  if (regionRaw.includes(q)) return 700;

  // 2) 초성 검색 — 질의가 초성으로만 이뤄졌을 때
  if (CHOSEONG_ONLY.test(q)) {
    const cIdx = nameDoc.choseong.indexOf(q);
    if (cIdx === 0) return 650;
    if (cIdx > 0) return 600 - cIdx;
    return 0; // 초성 질의는 초성에만 매칭
  }

  // 3) 자모 부분일치 — 마지막 글자가 미완성이어도 잡힘
  const qJamo = query.jamo;
  if (qJamo.length >= 2 && nameDoc.jamo.includes(qJamo)) return 550;

  // 4) 자모 근사 부분일치 — 이름 어디서든 모음·받침 한두 끗 차이 오타 허용
  //    ("레미안"→"반포래미안...", "푸르지요"→"...푸르지오")
  if (qJamo.length >= 4) {
    const max = Math.max(1, Math.floor(qJamo.length / 5));
    const dist = approxSubstringDistance(qJamo, nameDoc.jamo, max);
    if (dist <= max) return 450 - dist * 60;
  }

  return 0;
}
