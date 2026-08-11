/**
 * The post-call analysis fields to write onto the Retell agent.
 *
 * Mirrors the `leads` columns that `reconcileLeadFromAnalysis` reads, so the two
 * cannot drift into a state where Retell extracts a field nothing consumes -- or
 * worse, where the reconcile path looks for one Retell was never asked to produce.
 *
 * The `is_emergency` description is the load-bearing line in this file. A model
 * that answers `false` because it feels obliged to answer is how a lead where
 * urgency was never established gets stored as explicitly routine -- which the whole
 * nullable-column design exists to prevent.
 */
export const ANALYSIS_FIELDS = [
  { type: 'string', name: 'name', description: "The caller's full name." },
  { type: 'string', name: 'phone', description: 'Callback number as digits.' },
  { type: 'string', name: 'address_line', description: 'Street address of the service location.' },
  { type: 'string', name: 'city', description: 'City of the service location.' },
  { type: 'string', name: 'zip', description: '5-digit ZIP of the service location.' },
  { type: 'string', name: 'problem', description: "The problem in the caller's own words." },
  {
    type: 'enum',
    name: 'system_type',
    choices: [
      'furnace',
      'air_conditioner',
      'heat_pump',
      'mini_split',
      'boiler',
      'water_heater',
      'thermostat',
      'other',
    ],
    description: 'Type of system discussed. Omit if never established.',
  },
  { type: 'number', name: 'system_age_years', description: 'Approximate age in years.' },
  {
    type: 'boolean',
    name: 'is_emergency',
    description:
      'True ONLY if urgency was actually established during the call: no heat in cold, no ' +
      'cooling in heat, water damage, or a gas/CO/burning hazard. If the agent never asked, ' +
      'OMIT this field entirely — do not answer false.',
  },
  {
    type: 'boolean',
    name: 'is_owner',
    description: 'True if the caller owns the property. Omit if not established.',
  },
  {
    type: 'boolean',
    name: 'is_commercial',
    description: 'True if this is a business rather than a home. Omit if not established.',
  },
] as const
