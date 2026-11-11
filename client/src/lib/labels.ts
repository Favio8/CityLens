/** 档案字段的中文标签。 */
import {
  FIGURE_EVIDENCE_PROPERTIES,
  type CoordSource,
  type VerificationStatus,
} from '@citylens/shared/schema';

export type FigureEvidence = (typeof FIGURE_EVIDENCE_PROPERTIES)[number];

export const COORD_SOURCE_LABELS: Record<CoordSource, string> = {
  local_gazetteer: '本地地名库',
  tianditu: '天地图',
  wikidata: 'Wikidata',
  preset_manual: '人工整理',
  city_center: '城市中心（约）',
};

export const VERIFICATION_LABELS: Record<VerificationStatus, string> = {
  verified_by_source: '来源可核验',
  pending_human_review: 'AI 整理',
  preset_manual: '人工整理',
};

export const EVIDENCE_LABELS: Record<FigureEvidence, string> = {
  birthplace: '籍贯',
  deathplace: '卒地',
  workplace: '任职地',
  position: '身份',
  preset_manual: '人工整理',
};

export function isPending(value: unknown): value is '待考' {
  return value === '待考';
}
