# Catalog size gate: five real exports

Measured on 2026-09-15 against engine commit `6d306d0`, Node v20.18.0. **Do not proceed with the proposed catalog-cleanup prototype on the assumption that the current engine can preserve and edit full bibliographic records.** This check found substantial failures for both book catalogs. Small journal records and a restricted title table mostly fit; that is a narrower technical result, not evidence of adoption.

All five files were downloaded completely and parsed to the end. No records were selected by size, sampled, or truncated. They are public publisher/library metadata exports, chosen for availability and format variety, not a random sample of cataloguers' working files. The BHL export is its title table; authors and subjects also exist in companion tables that were not joined here. The downloads may describe overlapping publications, so their record counts must not be interpreted as unique books or combined into a market-wide failure rate.

## Results

A minimal growing edit appends one ASCII byte to the title. The limits below use minidb's actual `encodeTuple()` and `__changes` schema. A row and every change receipt must individually fit within **4,060 bytes**.

| Export | Records | Too large for history-enabled import | Import fits, but edit fails | Total unable to complete import + edit | Failure rate |
| --- | ---: | ---: | ---: | ---: | ---: |
| [OpenEdition journal collections](https://marc-openedition.readthedocs.io/en/latest/access.html), MARC21 | 671 | 0 | 0 | 0 | 0% |
| [Oxford journals, January 2026](https://academic.oup.com/pages/institutional-account-management/marc-records/journals), MARC21 | 883 | 0 | 37 | 37 | 4.19% |
| [Project MUSE open-access books](https://about.muse.jhu.edu/librarians/marc-records/), MARC21 | 7,432 | 1,419 | 3,735 | 5,154 | 69.35% |
| [OAPEN Library](https://www.oapen.org/article/metadata), CSV | 52,004 | 864 | 26,357 | 27,221 | 52.34% |
| [Biodiversity Heritage Library title table](https://github.com/gbhl/bhl-open-data/blob/main/README.md), TSV | 192,039 | 0 | 2 | 2 | 0.00104% |

The import-then-edit failure is a substantive problem: importing successfully does not establish that a record is editable with history. A bulk transaction touching even one oversized receipt aborts as a unit.

| Export | Median update receipt, bytes | p95 | Largest |
| --- | ---: | ---: | ---: |
| OpenEdition | 814 | 988 | 1,444 |
| Oxford | 3,184 | 4,020 | 5,044 |
| MUSE | 5,560 | 10,471 | 59,977 |
| OAPEN | 4,134 | 6,714 | 24,794 |
| BHL titles | 684 | 1,035 | 5,094 |

Some records also exceed the ordinary row limit with history disabled: 861 MUSE rows and 857 OAPEN rows. The other three exports have no ordinary-row size failures under this representation. History creates many additional failures.

As a separate baseline, the [Library Carpentry DOAJ teaching sample](https://librarycarpentry.github.io/lc-open-refine/) has 1,001 records, all of which fit; its largest update receipt is 1,651 bytes. This curated teaching sample is **not one of the five full exports**. It demonstrates why a small teaching dataset or the earlier synthetic example can give a misleading impression of general catalog compatibility.

## Representation and validation

CSV/TSV: preserve every cell exactly as text, including empty strings, and add an integer internal primary key. CSV quoting and multiline cells are parsed normally; the BHL TSV uses unquoted tab-separated values. OAPEN has one empty physical line outside any quoted record; it is ignored and recorded in the manifest. No nonempty row or field is dropped.

MARC21: validate each declared record length, directory and terminator, require the UTF-8 encoding marker, decode strictly, then retain the leader and every complete field as separate text cells. Indicators, repeated fields and subfield separators remain present. Each record is measured using its own minimal field layout. A real shared fixed schema would require additional columns/NULLs, so **the MARC assessment is optimistic**. It is an isolated-record encoding experiment, not an implemented general MARC importer. UTF-8 decoding, record framing and CSV column-count checks passed for all five files.

To distinguish intrinsic text size from representation overhead, also count records whose field text alone, doubled for before/after, exceeds 4,060 bytes. For MARC this lower bound excludes the leader, indicators, subfield codes and framing. It still rules out **3,667 MUSE records (49.34%)** and **22,818 OAPEN records (43.88%)** in a single row retaining the original text values, even if all JSON and structural overhead were removed. Two BHL records also exceed it. Oxford's failures depend on the measured representation; do not present them as impossible under every alternative encoding.

Every normalized record was measured with the engine encoder. Representative fitting records, records near the boundary, ordinary-row failures, history-import failures, and history-update failures were then executed through real `Database` SQL calls with history both off and on. All **40 SQL checks** agreed with the size predictions. Successful history updates were undone and compared with the original row; rejected writes left the expected prior state intact. These are in-memory SQL checks of the current engine; no new disk-durability claim follows from them.

## The exact small-schema limit

The earlier 2,200-byte example was a failing test point, not a ceiling. There is no universal 1,900- or 2,000-byte field limit: table/key overhead, other cells, UTF-8 and JSON escaping affect the receipt.

For a same-length ASCII replacement, with key `1`:

| Schema | Largest tested text that updates | First failure | Receipt sizes |
| --- | ---: | ---: | --- |
| `t(id INT PRIMARY KEY, value TEXT)` | 2,001 bytes | 2,002 bytes | 4,059 / 4,061 bytes |
| `records(id INT PRIMARY KEY, value TEXT, c0 TEXT, c1 TEXT)`, other values `Example Press`, `History` | 1,972 bytes | 1,973 bytes | 4,059 / 4,061 bytes |

Both sides of both boundaries were verified through SQL, for four additional checks. These ASCII results are not safe validation limits for arbitrary records. Quotes, backslashes and line breaks expand in JSON; additional columns and larger keys consume space. Validate the encoded receipt if using this representation.

## Does the narrow projection rescue the proposal?

Measured the original `id/title/publisher/subject` idea separately. MARC projection retains title subfields `a/b/n/p`, publisher subfield `b` from 260/264, and all 6xx subject text. OAPEN uses its corresponding title, publisher and subject columns. BHL's `PublicationDetails` is used for publication information, and subject is absent from this title-table export.

| Export | Projected rows still too large for history update |
| --- | ---: |
| OpenEdition | 0 |
| Oxford | 0 |
| MUSE | 33 |
| OAPEN | 27 |
| BHL titles | 1 |

The projection retains about 21% of MUSE's and 18% of OAPEN's original field-value bytes; it omits abstracts, notes, identifiers and other fields. Byte proportions are not a measure of user value. Keeping omitted data in side files or separate rows would need an explicit export, identity and history design. No such design was implemented or tested here. A field-only editor may be possible, but the previous recommendation does not have evidence that cataloguers would accept that restriction.

**Decision:** stop the prototype recommendation in its current form. Full-record book cleanup fails the size gate; no engine expansion is justified by this result alone. The separate question about corrections overlapping on different columns of the same records remains unanswered and requires a cataloguer. No one was contacted. These results do not establish that the general workflow lacks demand or that all catalog exports fail.

## Reproduce

Download the five exports and supplementary sample using the exact URLs and filenames in [sources.json](catalog-size/sources.json). [results.json](catalog-size/results.json) retains the downloaded-file SHA-256 hashes, byte counts, record counts, distributions, source IDs for the SQL checks, and boundary results. Public downloads are mutable; compare hashes before expecting identical counts.

From the repository, with downloads in `/private/tmp`:

```sh
python3 docs/research/catalog-size/normalize.py /private/tmp /private/tmp/minidb-catalog-sizes
node --import tsx docs/research/catalog-size/measure.mjs /private/tmp/minidb-catalog-sizes
```

The [normalizer](catalog-size/normalize.py) and [measurement script](catalog-size/measure.mjs) require only Python's standard library and the repository's existing Node dependencies. Raw catalogs and normalized records remain in temporary storage; only the measurements and reproducibility code are saved in the repository.
