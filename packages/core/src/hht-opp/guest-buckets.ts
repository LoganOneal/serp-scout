/**
 * Guest-post discovery buckets.
 *
 * A bucket is an audience HHT can pitch (travel, romance, weddings, wellness,
 * city lifestyle). Each one has its own topical regex: a Google Ads idea or a
 * template keyword is kept only when it reads like that bucket's content.
 * Travel is the default and keeps the original TRAVEL_BLOG terms.
 */

export type GuestBucketId = 'travel' | 'romance' | 'weddings' | 'wellness' | 'lifestyle'

export interface GuestBucket {
  id: GuestBucketId
  label: string
  topical: RegExp
}

/** Original TRAVEL_BLOG terms, plus the destination phrasings the templates use. */
const TRAVEL_TOPICAL =
  /\b(travel|travell?ing|blog|hotels?|honeymoon|tourism|tourist|getaways?|destinations?|vacation|itinerary|resort|romantic|backpack|cruise|things to do|city guide|visitor|packing list|staycation|road trips?|day trips?|weekend in|hidden gems)\b/i

export const GUEST_BUCKETS: Readonly<Record<GuestBucketId, GuestBucket>> = {
  travel: { id: 'travel', label: 'Travel', topical: TRAVEL_TOPICAL },
  romance: {
    id: 'romance',
    label: 'Romance and couples',
    topical: /\b(romantic|romance|couples?|date (?:night|ideas?)|anniversary|valentines?|getaways?)\b/i,
  },
  weddings: {
    id: 'weddings',
    label: 'Weddings and honeymoons',
    topical: /\b(weddings?|honeymoons?|elope|elopements?|bridal|brides?|bachelorette|babymoons?|engagement|proposal)\b/i,
  },
  wellness: {
    id: 'wellness',
    label: 'Wellness and spa',
    topical: /\b(spas?|wellness|retreats?|hot springs?|hot tubs?|self[- ]care|relaxing|massage|yoga|detox|sauna)\b/i,
  },
  lifestyle: {
    id: 'lifestyle',
    label: 'Regional and city lifestyle',
    topical: /\b(things to do|this weekend|staycations?|brunch|restaurants?|date night|neighborhoods?|events|local guide|magazine)\b/i,
  },
}

export const GUEST_BUCKET_IDS = Object.keys(GUEST_BUCKETS) as GuestBucketId[]

export function isGuestBucketId(value: string | null | undefined): value is GuestBucketId {
  return value != null && Object.prototype.hasOwnProperty.call(GUEST_BUCKETS, value)
}

/**
 * Bucket config for a stored keyword's bucket label. Older rows carry free-form
 * labels such as `user_broad_travel`; anything that is not a bucket id is travel.
 */
export function guestBucket(id: string | null | undefined): GuestBucket {
  return isGuestBucketId(id) ? GUEST_BUCKETS[id] : GUEST_BUCKETS.travel
}
