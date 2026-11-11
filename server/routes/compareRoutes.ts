/**
 * 双城对比路由（P2-19）：GET /api/compare?cities=CN-610100,CN-330100。
 * - 恰好两座合法 cityId；城市不存在 400，任一未生成 404；
 * - 复用缓存档案（不调用大模型）；缺失字段由服务层统一填「待考」。
 */
import type { FastifyInstance } from 'fastify';
import { CityIdSchema } from '../../shared/schema';
import { ApiError } from '../errors';
import type { ArchiveRepo } from '../db/archiveRepo';
import type { CityRepo } from '../db/cityRepo';
import { loadBundle } from '../services/cacheService';
import { buildCompareCity } from '../services/compareService';

export interface CompareRouteDeps {
  repo: CityRepo;
  archiveRepo: ArchiveRepo;
}

function parseCities(raw: string | undefined): [string, string] {
  const parts = (raw ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length !== 2) {
    throw new ApiError('INVALID_QUERY', '请提供两座城市，如 cities=CN-610100,CN-330100', 400);
  }
  const [first, second] = parts.map((part) => CityIdSchema.safeParse(part));
  if (!first?.success || !second?.success) {
    throw new ApiError('INVALID_QUERY', 'city_id 格式应为 CN- 加 6 位行政区划代码', 400);
  }
  return [first.data, second.data];
}

export function registerCompareRoutes(app: FastifyInstance, deps: CompareRouteDeps): void {
  app.get<{ Querystring: { cities?: string } }>('/api/compare', async (request) => {
    const [firstId, secondId] = parseCities(request.query.cities);
    if (firstId === secondId) {
      throw new ApiError('INVALID_QUERY', '请选择两座不同的城市', 400);
    }

    const cities = [firstId, secondId].map((cityId) => {
      const city = deps.repo.getCity(cityId);
      if (!city) throw new ApiError('CITY_NOT_FOUND', `版图中暂无此城：${cityId}`, 404);
      const bundle = loadBundle(deps.archiveRepo, cityId);
      if (!bundle || bundle.archive.status === 'unpublished') {
        throw new ApiError(
          'NOT_GENERATED',
          `${city.standardName} 尚未成卷：请先生成该城档案后再来对比`,
          404,
        );
      }
      return buildCompareCity(city, bundle);
    });

    return { cities: [cities[0], cities[1]], generatedAt: new Date().toISOString() };
  });
}
