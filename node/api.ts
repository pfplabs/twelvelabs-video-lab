import { analysisEligible, statusDetail } from './domain.ts';
import { InventoryError, type InventoryProvider } from './providers.ts';

export function inventoryResponse(provider: InventoryProvider) {
  try {
    const videos = provider.listVideos().map(video => ({ ...video,
      analysis_eligible: analysisEligible(video), status_detail: statusDetail(video) }));
    return { status: 200, payload: { mode: 'synthetic', videos,
      eligible_count: videos.filter(video => video.analysis_eligible).length } };
  } catch (error) {
    if (!(error instanceof InventoryError)) throw error;
    return { status: 503, payload: { error: 'inventory_unavailable',
      message: 'Inventory unavailable. Processing status is unknown.' } };
  }
}
