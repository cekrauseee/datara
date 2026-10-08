import { z } from '@hono/zod-openapi'

export const Id = z.string().min(1).max(200)
export const Level = z.enum(['country', 'region', 'state', 'municipality', 'zone', 'section'])
export const PublicationQuery = z.object({ publicationId: z.uuid().optional() })
export const PageQuery = PublicationQuery.extend({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(10_000_000).default(0),
})
export const EditionQuery = z.object({
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
  year: z.coerce.number().int().min(1900).max(2100).optional(),
  round: z.coerce.number().int().min(1).max(2).optional(),
})
export const AreaQuery = PageQuery.extend({
  level: Level.optional(),
  parentId: Id.optional(),
  uf: z
    .string()
    .regex(/^[a-z]{2}$/)
    .optional(),
  municipalityCode: z.string().regex(/^\d+$/).optional(),
  zoneCode: z.string().regex(/^\d+$/).optional(),
  q: z.string().max(100).optional(),
})
export const CandidateQuery = PageQuery.extend({
  q: z.string().max(100).optional(),
  partyNumber: z.string().regex(/^\d+$/).optional(),
})
export const ResultQuery = PageQuery.extend({ areaId: Id.optional() })
export const DistributionQuery = PageQuery.extend({
  candidateId: Id,
  areaId: Id.optional(),
  level: Level.default('municipality'),
})
export const MapQuery = PublicationQuery.extend({
  areaId: Id.optional(),
  candidateId: Id.optional(),
  level: z.enum(['state', 'municipality']).default('municipality'),
  metric: z
    .enum(['candidateVotes', 'candidateShare', 'contribution', 'leader', 'margin', 'turnout'])
    .default('leader'),
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
const Publication = z
  .object({
    id: z.uuid(),
    scope: z.enum(['pilot', 'national']),
    publishedAt: z.string().nullable(),
    coverage: z.record(z.string(), z.unknown()),
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
    coalition: z.unknown(),
    federation: z.unknown(),
    runningMates: z.array(z.unknown()),
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
  coverage: Publication.shape.coverage,
  items: z.array(Area),
  pagination: Pagination,
})
export const ContestsResponse = z.object({
  publicationId: z.uuid(),
  coverage: Publication.shape.coverage,
  items: z.array(Contest),
})
export const CandidatesResponse = z.object({
  publicationId: z.uuid(),
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
    sectionsTotal: Count,
    sectionsCounted: Count,
  })
  .openapi('ResultTotals')
const Provenance = z.object({
  sourceKind: z.enum(['EA20', 'BU', 'aggregate']),
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
    coverage: Publication.shape.coverage,
    contest: Contest,
    area: Area,
    resultAreaId: Id,
    state: z.enum(['available', 'unavailable', 'shared']),
    complete: z.boolean(),
    officialStatus: z.string().nullable(),
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
  state: z.enum(['available', 'unavailable', 'shared']),
  complete: z.boolean(),
  sourceKind: z.enum(['EA20', 'BU', 'aggregate']).nullable(),
  votes: Count,
  support: Measure,
  contribution: Measure,
})
export const DistributionResponse = z.object({
  publicationId: z.uuid(),
  coverage: Publication.shape.coverage,
  contestId: Id,
  candidateId: Id,
  scopeAreaId: Id,
  items: z.array(DistributionItem),
  pagination: Pagination,
})
export const MapResponse = z.object({
  publicationId: z.uuid(),
  coverage: Publication.shape.coverage,
  contestId: Id,
  scopeAreaId: Id,
  level: z.string(),
  metric: z.string(),
  candidateId: Id.nullable(),
  items: z.array(
    z.object({
      areaId: Id,
      featureId: z.string(),
      value: z.number().nullable(),
      state: z.string(),
      sourceKind: z.string().nullable(),
      basis: z.string(),
      leaders: z.array(Id),
      tie: z.boolean(),
      complete: z.boolean(),
    }),
  ),
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
    description: 'Database unavailable',
    content: { 'application/json': { schema: ErrorSchema } },
  },
  500: {
    description: 'Unexpected server error',
    content: { 'application/json': { schema: ErrorSchema } },
  },
}
