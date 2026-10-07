# Official BU2026 pilot evidence

`porto-walter-0077-bu.dat` is the official first-round bulletin for Acre, Porto Walter (TSE 01066), zone 0004, section 0077. Collected 2026-10-06 from:

https://resultados.tse.jus.br/oficial/ele2026/arquivo-urna/3220/dados/ac/01066/0004/0077/4a6b704a7350756e6a5a496433337049453538516932486a676159553779785542752d6d765749354f41343d/o03220ac0106600040077-bu.dat

Selected through EA18's `Totalizado` hash. This directory is an archival excerpt; ingestion always uses the official inventory and auxiliary files.

`bu2026.asn1` is the unchanged September 2026 specification (`spec/bu.asn1`) from the TSE ZIP:

https://www.tse.jus.br/eleicoes/eleicoes-2026-content/arquivos/formato-arquivos-de-bu-rdv-e-assinatura-digital

The TypeScript parser was compared with `asn1tools` BER decoding against this exact specification. Both decoded eligible=289, turnout=234, presidential votes=234 and Senate votes=468. BU printed votes carry no judicial destination; these are not EA20 valid votes. The parser does not verify the cryptographic signature, accepts the official unencrypted BU envelope and rejects unsupported structures.

`abu-dhabi-0001-busa.dat` is the official SA bulletin for Abu Dhabi (TSE 29254), exterior zone 0001, section 0001:

https://resultados.tse.jus.br/oficial/ele2026/arquivo-urna/3220/dados/zz/29254/0001/0001/4e775470664942304b313957306243364331534d58774f516e32643856486f62445430394a61374d2b4f673d/o03220zz2925400010001-busa.dat

Official ASN.1 and TypeScript both decode eligible=91, presidential turnout/votes=44. Its optional `detalhamentoComparecimento` is absent and root `qtdEleitoresCompareceram=0`; normalization uses the election/office participation field, preserving its meaning.

`noronha-0146-bu.dat` is the official Fernando de Noronha (TSE 30015), zone 0004, section 0146 bulletin. It was selected via the official auxiliary URL:

https://resultados.tse.jus.br/oficial/ele2026/arquivo-urna/3220/dados/pe/30015/0004/0146/p003220-pe-m30015-z0004-s0146-aux.json

The district council uses the nonconstitutional office code 25, eligible=381 and turnout=261. In the same BU, presidency has eligible=382 and turnout=262. The checked fixture and isolated database test preserve this distinction. Independent official ASN.1 decoding confirmed all values.
