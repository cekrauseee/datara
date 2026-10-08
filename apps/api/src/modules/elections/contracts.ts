import { z } from '@hono/zod-openapi'

export const Id = z.string().min(1).max(200)
export const Level = z.enum(['country', 'region', 'state', 'municipality', 'zone', 'section'])
export const SourceKind = z.enum(['EA20', 'BU', 'aggregate'])
export const ResultState = z.enum(['available', 'unavailable', 'shared'])
export const MapLevel = z.enum(['state', 'municipality'])
export const MapMetric = z.enum([
  'candidateVotes',
  'candidateShare',
  'contribution',
  'leader',
  'margin',
  'turnout',
])
/** Official situation of a stored result, independent of the source's own codes. */
export const ResultStatus = z.enum([
  'notStarted',
  'inProgress',
  'finished',
  'printed',
  'regionComplete',
  'regionPartial',
  'unknown',
])
export const PublicationQuery = z.object({ publicationId: z.uuid().optional() })
export const PageQuery = PublicationQuery.extend({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(10_000_000).default(0),
})
// Two-letter codes are matched without regard to case.
const letters = z.string().regex(/^[a-zA-Z]{2}$/)
export const EditionQuery = z.object({
  country: letters.transform((v) => v.toUpperCase()).optional(),
  year: z.coerce.number().int().min(1900).max(2100).optional(),
  round: z.coerce.number().int().min(1).max(2).optional(),
})
export const AreaQuery = PageQuery.extend({
  level: Level.optional(),
  parentId: Id.optional(),
  uf: letters.transform((v) => v.toLowerCase()).optional(),
  municipalityCode: z.string().regex(/^\d+$/).optional(),
  zoneCode: z.string().regex(/^\d+$/).optional(),
  featureId: z
    .string()
    .regex(/^\d{1,7}$/)
    .optional(),
  q: z.string().max(100).optional(),
})
export const CandidateQuery = PageQuery.extend({
  q: z.string().max(100).optional(),
  partyNumber: z.string().regex(/^\d+$/).optional(),
  officialId: z.string().regex(/^\d+$/).optional(),
})
export const ResultQuery = PageQuery.extend({ areaId: Id.optional() })
export const DistributionQuery = PageQuery.extend({
  candidateId: Id,
  areaId: Id.optional(),
  level: Level.default('municipality'),
  sort: z.enum(['area', 'votes', 'support', 'contribution']).default('area'),
})
export const MapQuery = PublicationQuery.extend({
  areaId: Id.optional(),
  candidateId: Id.optional(),
  level: MapLevel.default('municipality'),
  metric: MapMetric.default('leader'),
})
const ElectionMapMetric = z.enum(['leader', 'margin', 'turnout'])
export const ElectionMapQuery = PublicationQuery.extend({
  officeCode: z.string().regex(/^\d{1,3}$/),
  level: MapLevel.default('municipality'),
  metric: ElectionMapMetric.default('leader'),
})
export const ErrorSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      requestId: z.string(),
      details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
    }),
  })
  .openapi('Error')
const Count = z.number().int().nonnegative().nullable()
const Total = z.number().int().nonnegative()
export const Coverage = z
  .object({
    scope: z.enum(['pilot', 'national']),
    complete: z.boolean(),
    expected: Total,
    completed: Total,
    officialAbsences: Total,
    results: Total,
    buResults: Total,
    buFiles: Total,
    aggregates: Total,
    reconciliation: z.string(),
    reconciledZoneResults: Total,
    unreconciledZoneResults: Total.nullable(),
    discrepancies: z.array(
      z.object({
        contestId: z.string(),
        areaId: z.string(),
        officialVotes: z.string(),
        printedVotes: z.string(),
      }),
    ),
    officialSectionStatuses: z.record(z.string(), Total).nullable(),
    sectionsWithoutAuxiliaryFile: Total.nullable(),
    selection: z
      .object({
        ufs: z.array(z.string()),
        municipalitiesPerUf: Total,
        primarySectionsPerUf: Total,
      })
      .nullable(),
  })
  .openapi('Coverage')
const Publication = z
  .object({
    id: z.uuid(),
    scope: z.enum(['pilot', 'national']),
    publishedAt: z.string().nullable(),
    coverage: Coverage,
  })
  .openapi('Publication')
export const Edition = z
  .object({
    id: Id,
    country: z.string(),
    year: z.number(),
    round: z.number(),
    electionDate: z.string(),
    publication: Publication.nullable(),
  })
  .openapi('Election')
export const EditionsResponse = z.object({ items: z.array(Edition) })
export const Area = z
  .object({
    id: Id,
    level: Level,
    name: z.string(),
    uf: z.string().nullable(),
    municipalityCode: z.string().nullable(),
    zoneCode: z.string().nullable(),
    sectionCode: z.string().nullable(),
    featureId: z.string().nullable(),
    parentId: z.string().nullable(),
    principalAreaId: z.string().nullable(),
  })
  .openapi('ElectoralArea')
export const Contest = z
  .object({
    id: Id,
    officeCode: z.string(),
    officeName: z.string(),
    electionId: z.string(),
    scopeAreaId: Id,
    seats: Count,
    voteType: z.string(),
  })
  .openapi('Contest')
// Inline (not named components): a nullable named schema loses its null in the OpenAPI output.
const Coalition = z.object({
  number: z.string(),
  name: z.string(),
  composition: z.string(),
  type: z.enum(['party', 'coalition', 'federation', 'unknown']),
})
const Federation = z.object({
  number: z.string(),
  name: z.string(),
  abbreviation: z.string(),
  composition: z.string(),
  partyNumbers: z.array(z.string()),
})
const RunningMate = z.object({
  name: z.string(),
  displayName: z.string(),
  partyAbbreviation: z.string(),
  officialId: z.string(),
  role: z.enum(['vice', 'firstSubstitute', 'secondSubstitute', 'unknown']),
})
export const Candidate = z
  .object({
    id: Id,
    officialId: z.string(),
    number: z.string(),
    name: z.string(),
    displayName: z.string(),
    color: z.string(),
    photoUrl: z.string().nullable(),
    party: z
      .object({
        number: z.string(),
        abbreviation: z.string(),
        name: z.string(),
        displayName: z.string().nullable(),
      })
      .nullable(),
    officialStatus: z.string().nullable(),
    voteDestination: z.string().nullable(),
    officialSelectedFlag: z.boolean().nullable(),
    officialStatusScopeAreaId: Id,
    coalition: Coalition.nullable(),
    federation: Federation.nullable(),
    runningMates: z.array(RunningMate),
  })
  .openapi('Candidate')
const Pagination = z.object({
  limit: z.number(),
  offset: z.number(),
  total: z.number(),
  hasMore: z.boolean(),
})
export const AreasResponse = z.object({
  publicationId: z.uuid(),
  coverage: Coverage,
  items: z.array(Area),
  pagination: Pagination,
})
export const ContestsResponse = z.object({
  publicationId: z.uuid(),
  coverage: Coverage,
  items: z.array(Contest),
})
export const CandidatesResponse = z.object({
  publicationId: z.uuid(),
  coverage: Coverage,
  items: z.array(Candidate),
  pagination: Pagination,
})
export const Measure = z
  .object({
    value: z.number().nullable(),
    numerator: Count,
    denominator: Count,
    basis: z.string(),
    state: z.enum(['available', 'unavailable', 'undefined']),
  })
  .openapi('PercentageMeasure')
export const Totals = z
  .object({
    eligible: Count,
    turnout: Count,
    abstentions: Count,
    totalVotes: Count,
    validVotes: Count,
    nominalVotes: Count,
    legendVotes: Count,
    blankVotes: Count,
    nullVotes: Count,
    noCandidateVotes: Count,
    sectionsTotal: Count,
    sectionsCounted: Count,
  })
  .openapi('ResultTotals')
const Provenance = z.object({
  sourceKind: SourceKind,
  sourceIds: z.array(z.uuid()),
  meaning: z.string(),
  generatedAt: z.string().nullable(),
})
const CandidateVote = z.object({
  candidate: Candidate,
  votes: Count,
  share: Measure,
  officialPercentage: z.object({ value: z.number(), basis: z.string() }).nullable(),
  voteDestination: z.string().nullable(),
})
const PartyVote = z.object({
  partyNumber: z.string(),
  nominalVotes: Count,
  validNominalVotes: Count,
  legendVotes: Count,
  validLegendVotes: Count,
})
const UnresolvedVote = z.object({
  number: z.string(),
  voteType: z.string(),
  partyNumber: z.string().nullable(),
  votes: z.number(),
})
const Summary = z.object({
  leaders: z.array(Id),
  tie: z.boolean(),
  candidateVoteDenominator: Count,
  shareBasis: z.string(),
  turnout: Measure,
  margin: z.object({ votes: Count, percentagePoints: z.number().nullable(), basis: z.string() }),
  seatCutoffMargin: z
    .object({ votes: Count, percentagePoints: z.number().nullable(), basis: z.string() })
    .nullable(),
})
export const ResultsResponse = z
  .object({
    publicationId: z.uuid(),
    coverage: Coverage,
    contest: Contest,
    area: Area,
    resultAreaId: Id,
    state: ResultState,
    complete: z.boolean(),
    officialStatus: ResultStatus.nullable(),
    officialStatusLabel: z.string().nullable(),
    officialStatusCode: z.string().nullable(),
    totals: Totals.nullable(),
    provenance: Provenance.nullable(),
    summary: Summary.nullable(),
    candidates: z.array(CandidateVote),
    pagination: Pagination,
    parties: z.array(PartyVote),
    unresolvedVotables: z.array(UnresolvedVote),
  })
  .openapi('AreaResult')
export const DistributionItem = z.object({
  area: Area,
  state: ResultState,
  complete: z.boolean(),
  sourceKind: SourceKind.nullable(),
  votes: Count,
  support: Measure,
  contribution: Measure,
})
export const DistributionResponse = z.object({
  publicationId: z.uuid(),
  coverage: Coverage,
  contestId: Id,
  candidateId: Id,
  scopeAreaId: Id,
  items: z.array(DistributionItem),
  pagination: Pagination,
})
const MapItem = z.object({
  areaId: Id,
  featureId: z.string(),
  value: z.number().nullable(),
  state: ResultState,
  sourceKind: SourceKind.nullable(),
  basis: z.string(),
  leaders: z.array(Id),
  tie: z.boolean(),
  complete: z.boolean(),
  // Percentage points between the two highest candidate counts, on the candidate-share basis.
  margin: z.number().nullable(),
})
// Candidacies referenced by map items (leaders and the selected candidacy), keyed by ID.
const MapCandidates = z.record(
  z.string(),
  Candidate.pick({
    id: true,
    officialId: true,
    number: true,
    displayName: true,
    color: true,
    photoUrl: true,
    party: true,
  }).extend({ contestId: Id }),
)
export const MapResponse = z.object({
  publicationId: z.uuid(),
  coverage: Coverage,
  contestId: Id,
  scopeAreaId: Id,
  level: MapLevel,
  metric: MapMetric,
  candidateId: Id.nullable(),
  items: z.array(MapItem),
  candidates: MapCandidates,
  omittedWithoutGeometry: z.number(),
  missingResults: z.number(),
})
export const ElectionMapResponse = z.object({
  publicationId: z.uuid(),
  coverage: Coverage,
  electionId: Id,
  officeCode: z.string(),
  level: MapLevel,
  metric: ElectionMapMetric,
  contests: z.array(Contest),
  items: z.array(MapItem.extend({ contestId: Id })),
  candidates: MapCandidates,
  omittedWithoutGeometry: z.number(),
  missingResults: z.number(),
})
export const SourceResponse = z
  .object({
    id: z.uuid(),
    publicationId: z.uuid(),
    url: z.url(),
    sha256: z.string(),
    kind: z.string(),
    generatedAt: z.string().nullable(),
    generatedAtOriginal: z.string().nullable(),
    collectedAt: z.string(),
    meaning: z.string(),
  })
  .openapi('Source')
export const errors = {
  400: {
    description: 'Invalid parameters or incompatible resource scope',
    content: { 'application/json': { schema: ErrorSchema } },
  },
  404: {
    description: 'Resource or requested publication not found',
    content: { 'application/json': { schema: ErrorSchema } },
  },
  503: {
    description: 'Database unavailable or query time limit exceeded',
    content: { 'application/json': { schema: ErrorSchema } },
  },
  500: {
    description: 'Unexpected server error',
    content: { 'application/json': { schema: ErrorSchema } },
  },
}
