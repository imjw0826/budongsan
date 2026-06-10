// GitHub Pages 프로젝트 사이트(/budongsan/)와 로컬(/) 양쪽에서 동작하도록
// 모든 내부 경로는 Vite base 를 기준으로 만든다.
export const BASE = import.meta.env.BASE_URL;

/** base 를 붙인 절대 경로. withBase("api/meta.json") → "/budongsan/api/meta.json" */
export function withBase(path: string) {
  return `${BASE}${path.replace(/^\//, "")}`;
}
