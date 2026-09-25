import type { HhtPxCluster, HhtPxKeywordTemplateSeed, HhtPxLinkability, HhtPxPriority } from './types.js'

function group(
  cluster: HhtPxCluster,
  variantGroup: string,
  priority: HhtPxPriority,
  expectedLinkability: HhtPxLinkability,
  templates: string[],
  geographic = true,
): HhtPxKeywordTemplateSeed[] {
  const seen = new Set<string>()
  const out: HhtPxKeywordTemplateSeed[] = []
  for (const template of templates) {
    const trimmed = template.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push({
      template: trimmed,
      cluster,
      variantGroup,
      priority,
      expectedLinkability,
      geographic,
      enabled: true,
    })
  }
  return out
}

const HOTEL_HOT_TUBS: HhtPxKeywordTemplateSeed[] = [
  ...group('hotel_hot_tubs', 'hotels_with_hot_tubs', 'high', 'medium_high', [
    'hotels with hot tubs in [GEO]',
    'hotels with a hot tub in [GEO]',
  ]),
  ...group('hotel_hot_tubs', 'hot_tub_hotels', 'high', 'medium_high', [
    'hot tub hotels in [GEO]',
    'best hotels with hot tubs in [GEO]',
  ]),
  ...group('hotel_hot_tubs', 'private_hot_tub_hotels', 'high', 'medium_high', [
    'hotels with private hot tubs in [GEO]',
    'private hot tub hotels in [GEO]',
    'hotels with private hot tub in [GEO]',
  ]),
  ...group('hotel_hot_tubs', 'private_hot_tub_room', 'high', 'medium_high', [
    'hotels with in room hot tubs in [GEO]',
    'hotels with in-room hot tubs in [GEO]',
    'hotels with hot tubs in room in [GEO]',
    'hotels with hot tub in room in [GEO]',
    'hotel rooms with private hot tubs in [GEO]',
  ]),
  ...group('hotel_hot_tubs', 'hotel_rooms_with_hot_tubs', 'high', 'medium_high', [
    'hotel rooms with hot tubs in [GEO]',
    'hotel rooms with a hot tub in [GEO]',
  ]),
  ...group('hotel_hot_tubs', 'hot_tub_suites', 'high', 'medium_high', [
    'hotel suites with hot tubs in [GEO]',
    'hot tub suites in [GEO]',
  ]),
  ...group('hotel_hot_tubs', 'hotels_with_jacuzzi', 'high', 'medium_high', [
    'hotels with jacuzzi in [GEO]',
    'hotels with jacuzzis in [GEO]',
    'jacuzzi hotels in [GEO]',
    'best jacuzzi hotels in [GEO]',
  ]),
  ...group('hotel_hot_tubs', 'jacuzzi_in_room', 'high', 'medium_high', [
    'hotels with jacuzzi in room in [GEO]',
    'hotels with a jacuzzi in room in [GEO]',
    'hotels with in room jacuzzi in [GEO]',
    'hotels with in-room jacuzzi in [GEO]',
    'hotel rooms with jacuzzi in [GEO]',
    'hotel rooms with a jacuzzi in [GEO]',
  ]),
  ...group('hotel_hot_tubs', 'private_jacuzzi', 'high', 'medium_high', [
    'hotels with private jacuzzi in [GEO]',
    'private jacuzzi hotels in [GEO]',
  ]),
  ...group('hotel_hot_tubs', 'jacuzzi_suites', 'high', 'medium_high', [
    'jacuzzi suites in [GEO]',
    'hotel suites with jacuzzi in [GEO]',
  ]),
  ...group('hotel_hot_tubs', 'whirlpool', 'high', 'medium_high', [
    'hotels with whirlpool tubs in [GEO]',
    'hotels with whirlpool in room in [GEO]',
    'hotels with whirlpool bath in [GEO]',
    'whirlpool suites in [GEO]',
  ]),
  ...group('hotel_hot_tubs', 'jetted_tub', 'high', 'medium_high', [
    'hotels with jetted tubs in [GEO]',
    'hotels with jetted tub in room in [GEO]',
    'hotels with jetted bathtubs in [GEO]',
  ]),
  ...group('hotel_hot_tubs', 'spa_tub', 'high', 'medium_high', [
    'hotels with spa tubs in [GEO]',
    'hotels with spa tub in room in [GEO]',
    'hotels with spa baths in [GEO]',
  ]),
  ...group('hotel_hot_tubs', 'soaking_tub', 'high', 'medium_high', [
    'hotels with soaking tubs in [GEO]',
    'hotels with deep soaking tubs in [GEO]',
    'hotels with two person tubs in [GEO]',
    'hotels with oversized tubs in [GEO]',
  ]),
  ...group('hotel_hot_tubs', 'balcony_rooftop_outdoor', 'high', 'medium_high', [
    'hotels with hot tubs on balcony in [GEO]',
    'hotels with balcony hot tubs in [GEO]',
    'hotels with private balcony hot tubs in [GEO]',
    'hotels with rooftop hot tubs in [GEO]',
    'hotels with outdoor hot tubs in [GEO]',
  ]),
  ...group('hotel_hot_tubs', 'resorts_luxury_boutique_romantic', 'high', 'medium_high', [
    'resorts with hot tubs in [GEO]',
    'resorts with private hot tubs in [GEO]',
    'resorts with jacuzzi in room in [GEO]',
    'luxury hotels with hot tubs in [GEO]',
    'boutique hotels with hot tubs in [GEO]',
    'romantic hotels with hot tubs in [GEO]',
    'bed and breakfasts with hot tubs in [GEO]',
    'inns with hot tubs in [GEO]',
    'lodges with hot tubs in [GEO]',
  ]),
]

const ROMANTIC_HOTELS: HhtPxKeywordTemplateSeed[] = [
  ...group('romantic_hotels', 'romantic_hotels', 'very_high', 'very_high', [
    'romantic hotels in [GEO]',
    'best romantic hotels in [GEO]',
    'most romantic hotels in [GEO]',
    'romantic places to stay in [GEO]',
    'best romantic places to stay in [GEO]',
    'romantic accommodations in [GEO]',
    'romantic lodging in [GEO]',
  ]),
  ...group('romantic_hotels', 'romantic_resorts', 'very_high', 'very_high', [
    'romantic resorts in [GEO]',
    'best romantic resorts in [GEO]',
    'couples resorts in [GEO]',
    'best resorts for couples in [GEO]',
  ]),
  ...group('romantic_hotels', 'hotels_for_couples', 'very_high', 'very_high', [
    'hotels for couples in [GEO]',
    'best hotels for couples in [GEO]',
    'couples hotels in [GEO]',
  ]),
  ...group('romantic_hotels', 'romantic_suites', 'very_high', 'very_high', [
    'romantic hotel suites in [GEO]',
    'romantic suites in [GEO]',
    'couples suites in [GEO]',
  ]),
  ...group('romantic_hotels', 'romantic_inns', 'very_high', 'very_high', [
    'romantic inns in [GEO]',
    'romantic bed and breakfasts in [GEO]',
  ]),
  ...group('romantic_hotels', 'adults_only', 'very_high', 'very_high', [
    'adults only hotels in [GEO]',
    'best adults only hotels in [GEO]',
    'adults only resorts in [GEO]',
    'best adults only resorts in [GEO]',
  ]),
  ...group('romantic_hotels', 'date_night_weekend', 'very_high', 'very_high', [
    'date night hotels in [GEO]',
    'romantic overnight stays in [GEO]',
    'romantic staycation in [GEO]',
    'couples staycation in [GEO]',
    'romantic weekend hotels in [GEO]',
  ]),
]

const ROMANTIC_GETAWAYS: HhtPxKeywordTemplateSeed[] = [
  ...group('romantic_getaways', 'romantic_getaways', 'very_high', 'very_high', [
    'romantic getaways in [GEO]',
    'best romantic getaways in [GEO]',
    'romantic weekend getaways in [GEO]',
    'best romantic weekend getaways in [GEO]',
  ]),
  ...group('romantic_getaways', 'couples_getaways', 'very_high', 'very_high', [
    'couples getaways in [GEO]',
    'best couples getaways in [GEO]',
    'weekend getaways for couples in [GEO]',
    'couples weekend getaway in [GEO]',
    'couples weekend trips in [GEO]',
  ]),
  ...group('romantic_getaways', 'weekend_getaways', 'very_high', 'very_high', [
    'weekend getaways in [GEO]',
    'best weekend getaways in [GEO]',
    'weekend trips in [GEO]',
  ]),
  ...group('romantic_getaways', 'retreats', 'very_high', 'very_high', [
    'romantic retreats in [GEO]',
    'couples retreats in [GEO]',
  ]),
  ...group('romantic_getaways', 'luxury_secluded_cozy', 'very_high', 'very_high', [
    'luxury getaways in [GEO]',
    'luxury weekend getaways in [GEO]',
    'secluded getaways in [GEO]',
    'cozy getaways in [GEO]',
  ]),
  ...group('romantic_getaways', 'romantic_vacation', 'very_high', 'very_high', [
    'romantic vacation in [GEO]',
    'romantic vacations in [GEO]',
    'couples vacation in [GEO]',
    'best couples vacations in [GEO]',
    'romantic trip to [GEO]',
    'couples trip to [GEO]',
  ]),
]

const HONEYMOON: HhtPxKeywordTemplateSeed[] = [
  ...group('honeymoon_anniversary', 'honeymoon_hotels', 'high', 'very_high', [
    'honeymoon hotels in [GEO]',
    'best honeymoon hotels in [GEO]',
    'honeymoon suites in [GEO]',
    'best honeymoon suites in [GEO]',
    'honeymoon resorts in [GEO]',
    'best honeymoon resorts in [GEO]',
  ]),
  ...group('honeymoon_anniversary', 'honeymoon_destinations', 'high', 'very_high', [
    'honeymoon destinations in [GEO]',
    'honeymoon getaways in [GEO]',
    'honeymoon ideas in [GEO]',
    'mini honeymoon in [GEO]',
    'minimoon in [GEO]',
    'minimoon destinations in [GEO]',
  ]),
  ...group('honeymoon_anniversary', 'anniversary', 'high', 'very_high', [
    'anniversary hotels in [GEO]',
    'hotels for anniversary in [GEO]',
    'anniversary getaways in [GEO]',
    'best anniversary getaways in [GEO]',
    'anniversary trip ideas in [GEO]',
    'anniversary trips in [GEO]',
    'anniversary weekend in [GEO]',
    'romantic anniversary getaway in [GEO]',
  ]),
]

const SPA: HhtPxKeywordTemplateSeed[] = [
  ...group('spa_wellness', 'spa_hotels', 'high', 'high', [
    'spa hotels in [GEO]',
    'best spa hotels in [GEO]',
    'luxury spa hotels in [GEO]',
  ]),
  ...group('spa_wellness', 'spa_resorts', 'high', 'high', [
    'spa resorts in [GEO]',
    'best spa resorts in [GEO]',
    'luxury spa resorts in [GEO]',
  ]),
  ...group('spa_wellness', 'hotel_spas', 'high', 'high', [
    'hotel spas in [GEO]',
    'best hotel spas in [GEO]',
  ]),
  ...group('spa_wellness', 'wellness', 'high', 'high', [
    'wellness hotels in [GEO]',
    'wellness resorts in [GEO]',
    'best wellness resorts in [GEO]',
  ]),
  ...group('spa_wellness', 'couples_spa', 'high', 'high', [
    'couples spa resorts in [GEO]',
    'couples spa hotels in [GEO]',
    'romantic spa resorts in [GEO]',
    'romantic spa hotels in [GEO]',
  ]),
  ...group('spa_wellness', 'spa_getaways', 'high', 'high', [
    'spa getaways in [GEO]',
    'spa weekend in [GEO]',
    'spa weekend getaways in [GEO]',
    'couples spa getaways in [GEO]',
    'romantic spa getaways in [GEO]',
    'wellness getaways in [GEO]',
  ]),
  ...group('spa_wellness', 'hotels_with_spas', 'high', 'high', [
    'hotels with spas in [GEO]',
    'resorts with spas in [GEO]',
    'hotels with spa and hot tub in [GEO]',
  ]),
]

const UNIQUE: HhtPxKeywordTemplateSeed[] = [
  ...group('unique_boutique_luxury', 'unique_hotels', 'medium_high', 'high', [
    'unique hotels in [GEO]',
    'best unique hotels in [GEO]',
    'cool hotels in [GEO]',
    'coolest hotels in [GEO]',
    'unusual hotels in [GEO]',
    'quirky hotels in [GEO]',
  ]),
  ...group('unique_boutique_luxury', 'unique_places', 'medium_high', 'high', [
    'unique places to stay in [GEO]',
    'best unique places to stay in [GEO]',
    'cool places to stay in [GEO]',
  ]),
  ...group('unique_boutique_luxury', 'boutique', 'medium_high', 'high', [
    'boutique hotels in [GEO]',
    'best boutique hotels in [GEO]',
    'luxury boutique hotels in [GEO]',
  ]),
  ...group('unique_boutique_luxury', 'luxury', 'medium_high', 'high', [
    'luxury hotels in [GEO]',
    'best luxury hotels in [GEO]',
    'luxury resorts in [GEO]',
    'best luxury resorts in [GEO]',
  ]),
  ...group('unique_boutique_luxury', 'historic_cozy_secluded', 'medium_high', 'high', [
    'historic hotels in [GEO]',
    'best historic hotels in [GEO]',
    'cozy hotels in [GEO]',
    'secluded hotels in [GEO]',
  ]),
  ...group('unique_boutique_luxury', 'best_hotels', 'medium_high', 'high', [
    'best hotels in [GEO]',
    'top hotels in [GEO]',
    'best resorts in [GEO]',
  ]),
  ...group('unique_boutique_luxury', 'hotel_suites', 'medium_high', 'high', [
    'hotel suites in [GEO]',
    'best hotel suites in [GEO]',
    'luxury hotel suites in [GEO]',
  ]),
]

const ADJACENT: HhtPxKeywordTemplateSeed[] = [
  ...group('adjacent_amenities', 'fireplaces_balconies', 'high', 'very_high', [
    'hotels with fireplaces in [GEO]',
    'hotels with fireplace in room in [GEO]',
    'hotels with private balconies in [GEO]',
    'hotels with romantic rooms in [GEO]',
  ]),
  ...group('adjacent_amenities', 'bathtubs', 'high', 'very_high', [
    'hotels with bathtubs in [GEO]',
    'hotels with large bathtubs in [GEO]',
    'hotels with clawfoot tubs in [GEO]',
    'hotels with freestanding tubs in [GEO]',
  ]),
  ...group('adjacent_amenities', 'private_pools', 'high', 'very_high', [
    'hotels with private pools in [GEO]',
    'hotels with private plunge pools in [GEO]',
    'hotels with plunge pools in [GEO]',
    'hotels with outdoor baths in [GEO]',
  ]),
  ...group('adjacent_amenities', 'views', 'high', 'very_high', [
    'hotels with ocean views in [GEO]',
    'hotels with mountain views in [GEO]',
    'hotels with views in [GEO]',
  ]),
]

const CABINS: HhtPxKeywordTemplateSeed[] = [
  ...group('cabins_lodges', 'cabins_hot_tub', 'medium', 'high', [
    'cabins with hot tubs in [GEO]',
    'cabins with jacuzzi in [GEO]',
    'romantic cabins in [GEO]',
    'best romantic cabins in [GEO]',
    'cabins for couples in [GEO]',
    'luxury cabins in [GEO]',
  ]),
  ...group('cabins_lodges', 'cottages_lodges_glamping', 'medium', 'high', [
    'cottages with hot tubs in [GEO]',
    'romantic cottages in [GEO]',
    'romantic lodges in [GEO]',
    'glamping with hot tubs in [GEO]',
    'romantic glamping in [GEO]',
  ]),
  ...group('cabins_lodges', 'setting_cabins', 'medium', 'high', [
    'mountain cabins with hot tubs in [GEO]',
    'lake cabins with hot tubs in [GEO]',
  ]),
]

const SEASONAL: HhtPxKeywordTemplateSeed[] = [
  ...group('seasonal', 'winter', 'medium_high', 'high', [
    'winter getaways in [GEO]',
    'best winter getaways in [GEO]',
    'winter weekend getaways in [GEO]',
    'romantic winter getaways in [GEO]',
    'cozy winter getaways in [GEO]',
  ]),
  ...group('seasonal', 'fall', 'medium_high', 'high', [
    'fall getaways in [GEO]',
    'best fall getaways in [GEO]',
    'romantic fall getaways in [GEO]',
  ]),
  ...group('seasonal', 'spring', 'medium_high', 'high', [
    'spring getaways in [GEO]',
    'romantic spring getaways in [GEO]',
  ]),
  ...group('seasonal', 'summer', 'medium_high', 'high', [
    'summer getaways in [GEO]',
    'romantic summer getaways in [GEO]',
  ]),
  ...group('seasonal', 'valentines', 'medium_high', 'high', [
    'valentines day getaways in [GEO]',
    'valentines weekend getaways in [GEO]',
    'romantic valentines getaway in [GEO]',
  ]),
  ...group('seasonal', 'new_years', 'medium_high', 'high', [
    'new years getaways in [GEO]',
    'new years eve getaways in [GEO]',
    'romantic new years getaway in [GEO]',
  ]),
  ...group('seasonal', 'christmas_holiday', 'medium_high', 'high', [
    'christmas getaways in [GEO]',
    'romantic christmas getaway in [GEO]',
    'holiday getaways in [GEO]',
  ]),
]

const SETTING: HhtPxKeywordTemplateSeed[] = [
  ...group('ski_beach_mountain_lake', 'ski', 'medium_high', 'high', [
    'ski hotels with hot tubs in [GEO]',
    'ski resorts with hot tubs in [GEO]',
    'romantic ski resorts in [GEO]',
    'best ski hotels in [GEO]',
  ]),
  ...group('ski_beach_mountain_lake', 'beach', 'medium_high', 'high', [
    'beach hotels with hot tubs in [GEO]',
    'beach resorts with hot tubs in [GEO]',
    'romantic beach hotels in [GEO]',
    'romantic beach resorts in [GEO]',
  ]),
  ...group('ski_beach_mountain_lake', 'mountain', 'medium_high', 'high', [
    'mountain hotels with hot tubs in [GEO]',
    'mountain resorts with hot tubs in [GEO]',
    'romantic mountain resorts in [GEO]',
    'mountain getaways in [GEO]',
    'romantic mountain getaways in [GEO]',
  ]),
  ...group('ski_beach_mountain_lake', 'lake', 'medium_high', 'high', [
    'lake hotels in [GEO]',
    'lakefront hotels in [GEO]',
    'romantic lake hotels in [GEO]',
    'lake getaways in [GEO]',
    'romantic lake getaways in [GEO]',
  ]),
]

const PLANNING: HhtPxKeywordTemplateSeed[] = [
  ...group('destination_planning', 'where_to_stay', 'medium', 'high', [
    'where to stay in [GEO]',
    'best places to stay in [GEO]',
    'where to stay in [GEO] for couples',
    'where to stay in [GEO] for honeymoon',
    'where to stay in [GEO] for anniversary',
  ]),
  ...group('destination_planning', 'things_to_do', 'medium', 'high', [
    'romantic things to do in [GEO]',
    'best romantic things to do in [GEO]',
    'things to do in [GEO] for couples',
    'couples activities in [GEO]',
    'date ideas in [GEO]',
  ]),
  ...group('destination_planning', 'weekend_itinerary', 'medium', 'high', [
    'romantic weekend in [GEO]',
    'couples weekend in [GEO]',
    'romantic itinerary [GEO]',
    'couples itinerary [GEO]',
    'weekend itinerary [GEO]',
    '2 day itinerary [GEO]',
    '3 day itinerary [GEO]',
  ]),
  ...group('destination_planning', 'trip_vacation', 'medium', 'high', [
    'romantic vacation [GEO]',
    'couples vacation [GEO]',
    'romantic trip [GEO]',
    'couples trip [GEO]',
  ]),
]

const OCCASION: HhtPxKeywordTemplateSeed[] = [
  ...group('occasion', 'birthday', 'low_medium', 'high', [
    'birthday getaway in [GEO]',
    'romantic birthday getaway in [GEO]',
    'birthday weekend in [GEO]',
  ]),
  ...group('occasion', 'proposal_engagement', 'low_medium', 'high', [
    'proposal getaway in [GEO]',
    'romantic proposal ideas in [GEO]',
    'engagement getaway in [GEO]',
  ]),
  ...group('occasion', 'babymoon', 'low_medium', 'high', [
    'babymoon hotels in [GEO]',
    'babymoon resorts in [GEO]',
    'babymoon destinations in [GEO]',
  ]),
  ...group('occasion', 'elopement', 'low_medium', 'high', [
    'elopement hotels in [GEO]',
    'romantic elopement destinations in [GEO]',
  ]),
]

const HOT_SPRINGS: HhtPxKeywordTemplateSeed[] = group(
  'hot_springs',
  'hot_springs',
  'low_medium',
  'high',
  [
    'hot springs hotels in [GEO]',
    'hot springs resorts in [GEO]',
    'best hot springs resorts in [GEO]',
    'romantic hot springs resorts in [GEO]',
    'hot springs getaways in [GEO]',
  ],
)

const NATIONAL: HhtPxKeywordTemplateSeed[] = [
  ...group('national_editorial', 'best_hot_tub_national', 'high', 'high', [
    'best hotels with private hot tubs',
    'best hotels with hot tubs in room',
    'best hotels with jacuzzi in room',
    'best jacuzzi suites',
    'best romantic hotels with hot tubs',
  ], false),
  ...group('national_editorial', 'best_destinations_national', 'high', 'high', [
    'best destinations for hot tub hotels',
    'best cities for hotels with hot tubs',
    'best cities for romantic hotels',
    'best cities for couples getaways',
    'best states for romantic getaways',
    'best winter romantic getaways',
    'best winter hot tub destinations',
  ], false),
  ...group('national_editorial', 'how_to_find', 'medium_high', 'very_high', [
    'how to find hotels with private hot tubs',
    'how to find hotels with hot tubs in room',
    'how to find hotels with jacuzzi suites',
    'how to book a hotel room with a jacuzzi',
    'how to book a jacuzzi suite',
  ], false),
  ...group('national_editorial', 'definitions', 'medium', 'very_high', [
    'what is a jacuzzi suite',
    'what is a whirlpool suite',
    'what is a spa tub in a hotel',
    'what is a jetted tub in a hotel',
    'jacuzzi vs hot tub hotel',
    'jacuzzi vs whirlpool tub',
    'spa tub vs jacuzzi',
    'jetted tub vs jacuzzi',
  ], false),
  ...group('national_editorial', 'hygiene_safety', 'medium', 'very_high', [
    'are hotel hot tubs safe',
    'are hotel jacuzzis safe',
    'are hotel hot tubs clean',
    'are hotel jacuzzis sanitary',
    'how clean are hotel hot tubs',
    'hotel hot tub safety',
    'hotel jacuzzi safety',
  ], false),
  ...group('national_editorial', 'romantic_amenities', 'high', 'very_high', [
    'best hotel amenities for couples',
    'romantic hotel amenities',
    'best romantic hotel amenities',
    'honeymoon suite amenities',
    'what makes a hotel romantic',
    'best hotel rooms for couples',
  ], false),
  ...group('national_editorial', 'hot_tub_vacation', 'high', 'high', [
    'private hot tub vacation',
    'private hot tub vacation ideas',
    'romantic hot tub vacation',
    'hot tub weekend getaway',
    'romantic hot tub getaway',
  ], false),
]

const NEAR: HhtPxKeywordTemplateSeed[] = group(
  'near_queries',
  'near_geo',
  'low',
  'medium',
  [
    'hotels with hot tubs near [GEO]',
    'hotels with private hot tubs near [GEO]',
    'hotels with jacuzzi near [GEO]',
    'hotels with jacuzzi in room near [GEO]',
    'romantic hotels near [GEO]',
    'romantic getaways near [GEO]',
    'spa resorts near [GEO]',
  ],
)

export const HHT_PX_KEYWORD_IDEA_SEEDS = [
  'hotels with hot tubs',
  'hotels with jacuzzi',
  'romantic hotels',
  'romantic getaways',
  'couples getaways',
  'spa hotels',
  'spa resorts',
  'honeymoon hotels',
  'unique hotels',
  'hotel suites',
] as const

/** Deterministic master keyword library. Geographic templates still contain `[GEO]`. */
export const HHT_PX_KEYWORD_TEMPLATES: readonly HhtPxKeywordTemplateSeed[] = [
  ...HOTEL_HOT_TUBS,
  ...ROMANTIC_HOTELS,
  ...ROMANTIC_GETAWAYS,
  ...HONEYMOON,
  ...SPA,
  ...UNIQUE,
  ...ADJACENT,
  ...CABINS,
  ...SEASONAL,
  ...SETTING,
  ...PLANNING,
  ...OCCASION,
  ...HOT_SPRINGS,
  ...NATIONAL,
  ...NEAR,
]

export function hhtPxTemplateByPhrase(template: string): HhtPxKeywordTemplateSeed | undefined {
  return HHT_PX_KEYWORD_TEMPLATES.find((row) => row.template === template)
}
