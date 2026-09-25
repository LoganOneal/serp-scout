import { HHT_SITE_ORIGIN, type HhtPxCluster, type HhtPxGeoType, type HhtPxWhyLinkCategory } from './types.js'

export interface TargetGeo {
  name: string
  type: HhtPxGeoType
  state: string | null
  hhtSlug: string | null
}

export interface RecommendedTarget {
  url: string
  kind: 'city' | 'state' | 'editors_choice' | 'explorer' | 'editorial'
  reason: string
}

export function recommendHhtTargetUrl(args: {
  geographies: readonly TargetGeo[]
  cluster: HhtPxCluster
}): RecommendedTarget {
  const city = args.geographies.find((geo) => geo.type === 'city' && geo.hhtSlug)
  if (city?.hhtSlug) {
    return {
      url: `${HHT_SITE_ORIGIN}/${city.hhtSlug.replace(/^\//, '')}`,
      kind: 'city',
      reason: `Exact Hotel Hot Tubs city page for ${city.name}.`,
    }
  }

  const region = args.geographies.find((geo) => geo.type === 'destination_region' && geo.hhtSlug)
  if (region?.hhtSlug) {
    return {
      url: `${HHT_SITE_ORIGIN}/${region.hhtSlug.replace(/^\//, '')}`,
      kind: 'state',
      reason: `Closest Hotel Hot Tubs destination page for ${region.name}.`,
    }
  }

  const state = args.geographies.find((geo) => geo.type === 'state' && geo.hhtSlug)
  if (state?.hhtSlug) {
    return {
      url: `${HHT_SITE_ORIGIN}/${state.hhtSlug.replace(/^\//, '')}`,
      kind: 'state',
      reason: `Hotel Hot Tubs state page for ${state.name}.`,
    }
  }

  if (args.cluster === 'hotel_hot_tubs' || args.cluster === 'national_editorial') {
    return {
      url: `${HHT_SITE_ORIGIN}/editors-choice`,
      kind: 'editors_choice',
      reason: "Editor's Choice is the strongest national inventory collection.",
    }
  }

  return {
    url: HHT_SITE_ORIGIN,
    kind: 'explorer',
    reason: 'Hotel Hot Tubs location explorer is the fallback destination URL.',
  }
}

export function whyTheyCouldLink(args: {
  cluster: HhtPxCluster
  geographyName: string | null
  pageTitle: string | null
}): { category: HhtPxWhyLinkCategory; explanation: string } {
  const place = args.geographyName ?? 'this destination'
  const title = (args.pageTitle ?? '').toLowerCase()

  if (args.cluster === 'adjacent_amenities' || /fireplace|balcony|bathtub|plunge pool|clawfoot/.test(title)) {
    return {
      category: 'amenity_extension',
      explanation: `The article focuses on a differentiated hotel amenity. Hotel Hot Tubs provides a complementary database of ${place} hotels with private and shared hot tubs.`,
    }
  }
  if (args.cluster === 'national_editorial' && /safe|clean|sanitary|what is|vs /.test(title)) {
    return {
      category: 'data_citation',
      explanation: `The article discusses hotel-amenity definitions or hygiene. Hotel Hot Tubs can be cited as a specialized dataset of hotels with verified hot tub inventory.`,
    }
  }
  if (/recommend|best hotels|where to stay|properties/.test(title)) {
    return {
      category: 'property_verification',
      explanation: `The article recommends properties in ${place}. Several may also be listed or verified on Hotel Hot Tubs, which readers can use to confirm hot-tub amenities.`,
    }
  }
  return {
    category: 'resource_extension',
    explanation: `The article covers ${clusterPhrase(args.cluster)} in ${place}, while Hotel Hot Tubs provides a specialized resource for readers looking for hotels with private or shared hot tubs.`,
  }
}

function clusterPhrase(cluster: HhtPxCluster): string {
  switch (cluster) {
    case 'romantic_hotels':
      return 'romantic hotels'
    case 'romantic_getaways':
      return 'romantic getaways'
    case 'honeymoon_anniversary':
      return 'honeymoon or anniversary stays'
    case 'spa_wellness':
      return 'spa hotels'
    case 'unique_boutique_luxury':
      return 'distinctive hotels'
    case 'cabins_lodges':
      return 'romantic cabins and lodges'
    case 'seasonal':
      return 'seasonal getaways'
    case 'ski_beach_mountain_lake':
      return 'setting-specific stays'
    case 'destination_planning':
      return 'where to stay'
    case 'occasion':
      return 'occasion-based getaways'
    case 'hot_springs':
      return 'hot springs hotels'
    case 'hotel_hot_tubs':
      return 'hotels with hot tubs'
    default:
      return 'romantic travel'
  }
}
