import { describe, expect, it } from 'vitest';
import { extractStatsFromText, isCityLevelBulletin } from './cityRecon';

describe('cityRecon', () => {
  it('只接受以本城为主体的统计公报', () => {
    expect(isCityLevelBulletin('南京市2025年国民经济和社会发展统计公报', '南京')).toBe(true);
    expect(isCityLevelBulletin('南京市江宁区2025年国民经济和社会发展统计公报', '南京')).toBe(
      false,
    );
    expect(isCityLevelBulletin('江宁区2025年国民经济和社会发展统计公报', '南京')).toBe(false);
    expect(isCityLevelBulletin('南京市2025年政府工作报告', '南京')).toBe(false);
  });

  it('从统计公报正文提取 GDP 与常住人口', () => {
    const text =
      '2025年，全市实现地区生产总值18500.81亿元，比上年增长4.5%。年末全市常住人口957.70万人，比上年末增加3.0万人。';
    const result = extractStatsFromText(text, 'https://tjj.nanjing.gov.cn/a.html');
    expect(result.gdp).toMatchObject({ year: 2025, value: 18500.81 });
    expect(result.pop).toMatchObject({ year: 2025, value: 957.7 });
    expect(result.gdp?.evidence).toContain('地区生产总值');
  });

  it('拒绝数量级异常的数字', () => {
    const text = '2025年地区生产总值12亿元，常住人口99999万人。';
    const result = extractStatsFromText(text, 'https://example.gov.cn/a.html');
    expect(result.gdp).toBeNull();
    expect(result.pop).toBeNull();
  });
});
