// TSE BU2026 ASN.1 (September 2026): EntidadeEnvelopeGenerico and EntidadeBoletimUrna.
// This is a strict, bounded BER TLV reader for the fields we consume; encrypted envelopes fail closed.
type Node = { tag: number; bytes: Buffer; children: Node[] }
function read(bytes: Buffer, depth = 0): Node[] {
  if (depth > 30) throw new Error('BU nesting exceeds limit')
  const nodes: Node[] = []
  for (let offset = 0; offset < bytes.length;) {
    const tag = bytes[offset++]!
    if ((tag & 31) === 31) throw new Error('Unsupported BU high tag')
    let length = bytes[offset++]
    if (length === undefined || length === 128) throw new Error('Invalid BU length')
    if (length & 128) {
      const count = length & 127
      if (count > 4 || offset + count > bytes.length) throw new Error('Invalid BU length')
      length = bytes.readUIntBE(offset, count)
      offset += count
    }
    if (offset + length > bytes.length) throw new Error('Truncated BU')
    const value = bytes.subarray(offset, offset + length)
    nodes.push({ tag, bytes: value, children: tag & 32 ? read(value, depth + 1) : [] })
    offset += length
  }
  return nodes
}
function integer(node: Node | undefined): number {
  if (!node || !node.bytes.length || node.bytes.length > 6 || node.bytes[0]! & 128)
    throw new Error('Invalid BU nonnegative integer')
  return node.bytes.readUIntBE(0, node.bytes.length)
}
function sequence(node: Node | undefined): Node[] {
  if (!node || node.tag !== 48) throw new Error('Invalid BU sequence')
  return node.children
}
export function decodeBu(bytes: Buffer) {
  const roots = read(bytes)
  if (roots.length !== 1) throw new Error('Trailing BU data')
  const envelope = sequence(roots[0])
  if (
    envelope.length !== 5 ||
    integer(envelope[1]) !== 2 ||
    integer(envelope[3]) !== 1 ||
    envelope[4]?.tag !== 4
  )
    throw new Error('BU must be an official, unencrypted bulletin envelope')
  const body = sequence(read(envelope[4].bytes)[0])
  if (body.length < 9 || integer(body[1]) !== 2) throw new Error('Invalid official BU2026')
  const identity = sequence(body[3])
  const municipalityZone = sequence(identity[0])
  const elections = sequence(body[body[7]?.tag === 161 ? 8 : 7]).map((entry) => {
    const election = sequence(entry)
    if (election.length !== 7) throw new Error('Unsupported BU election structure')
    return {
      electionId: String(integer(election[0])),
      eligible: integer(election[1]),
      eligibleOriginal: integer(election[2]),
      eligibleTemporary: integer(election[3]),
      offices: sequence(election[4]).flatMap((group) => {
        const result = sequence(group)
        return sequence(result[2]).map((office) => {
          const cargo = sequence(office)
          const votes = sequence(cargo[2]).map((vote) => {
            const tuple = sequence(vote)
            if (tuple[0]?.tag !== 129 || tuple[1]?.tag !== 130)
              throw new Error('Invalid BU vote tuple')
            const type = integer(tuple[0])
            if (type < 1 || type > 5) throw new Error('Unsupported BU vote type')
            const candidate = tuple[2]?.tag === 163 ? tuple[2].children : null
            return {
              type,
              votes: integer(tuple[1]),
              party: candidate ? String(integer(candidate[0])) : null,
              number: candidate ? String(integer(candidate[1])) : null,
            }
          })
          return { officeCode: String(integer(cargo[0])), turnout: integer(result[1]), votes }
        })
      }),
    }
  })
  return {
    municipality: String(integer(municipalityZone[0])).padStart(5, '0'),
    zone: String(integer(municipalityZone[1])).padStart(4, '0'),
    section: String(integer(identity[2])).padStart(4, '0'),
    emittedAt: body[4]!.bytes.toString(),
    turnout: integer(body[6]),
    elections,
  }
}
