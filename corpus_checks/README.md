# Corpus checks

Scripts that run this repository's code against the real-world test corpus: 517 Part 21 files, 421 MB, 4.9 M
instances (see `../test_corpus/README.md`). They complement the package tests (`npm test`), which use small inline
fixtures and don't need the corpus. Each phase 1 step added the check that verified it; the results and what they
found are recorded in `../docs/phase1_progress.md`.

## Setup

Fetch the corpus once with `../test_corpus/third_party/pull.sh`. The scripts find it relative to the repository, so
they run from any directory; a check stops with a hint to run `pull.sh` if listed files are missing. The checks that
read the whole corpus take an optional list file in place of `../test_corpus/files.txt`, one path per line relative to
`../test_corpus/third_party/`.

## The checks

| Script | Step | What it does | Time |
|---|---|---|---|
| `json_corpus.ts` | 4 | Parse (A) → raw JSON → load (B) → Part 21 → parse (C), comparing every instance, the header and the DATA sections (A ≡ B and A ≡ C); also checks that `JSON.parse` accepts the JSON and that writing B again gives the same bytes. Expect 0 instances differing. | ~1 min |
| `number_kinds.ts` | 4 | Binds every int and real to its schema slot and tallies what the schema says the slot holds (INTEGER, REAL, NUMBER, SELECT, no context). Shows that context alone can't tell ints from reals, and lists the number-kind violations Layer 2 must tolerate. | ~1 min |
| `writer_corpus.ts` | 3 | Parse (A) → write → parse (C), comparing every instance, the header and the DATA sections (A ≡ C); then writes C again, which must be byte-identical, and checks the verbatim fast path (source bytes copied) the same way. Expect 0 instances differing. | ~1.5 min |
| `parser_corpus.ts` | 2 | Parses and decodes every instance, tallies diagnostics and decode errors, and checks each instance's attributes against the schema dictionaries (slot counts, derived slots, unknown entities). | ~12 s |
| `parser_lenient_quotes.ts` | 2 | Lists the files and strings where the lenient end-of-string rule (a lone `'` ends a string only before `,` or `)`) reads differently from the strict one. | ~4 s |
| `parser_bench.ts` | 2 | Scan and decode speed and index memory for the files named on the command line (paths relative to `../test_corpus/third_party/`). | seconds |
| `schema_corpus_check.ts` | 1 | The original dictionary check, with a crude tokenizer written before the parser existed. Superseded by `parser_corpus.ts`; kept because `schema_xdict.ts` reads its log. | ~7 s |
| `schema_xdict.ts` | 1 | Compares the four dictionaries' attribute layouts with AP242's, and looks up in AP242 the entities that `schema_corpus_check.log` reports as unknown to a file's own schema. Takes that log as its argument. | < 1 s |

`corpus.ts` is the shared helper: the repository and corpus locations, the file list, and short names for reports.

## Reference outputs

The `.log` files are the outputs the progress document cites. To compare a fresh run with one, diff everything but the
lines with timings (line 2 of the writer and JSON logs, line 1 of the parser log), for example:

```sh
node corpus_checks/json_corpus.ts > /tmp/j.log && diff <(sed 2d corpus_checks/json_corpus.log) <(sed 2d /tmp/j.log)
node corpus_checks/number_kinds.ts > /tmp/n.log && diff corpus_checks/number_kinds.log /tmp/n.log
node corpus_checks/writer_corpus.ts > /tmp/w.log && diff <(sed 2d corpus_checks/writer_corpus.log) <(sed 2d /tmp/w.log)
node corpus_checks/parser_corpus.ts > /tmp/p.log && diff <(sed 1d corpus_checks/parser_corpus.log) <(sed 1d /tmp/p.log)
node corpus_checks/schema_corpus_check.ts > /tmp/s.log && diff corpus_checks/schema_corpus_check.log /tmp/s.log
node corpus_checks/schema_xdict.ts corpus_checks/schema_corpus_check.log
node corpus_checks/parser_bench.ts gkv311-opencascade-dataset/step/bug31711.stp gkv311-opencascade-dataset/step/Median_cx-fs01_bicycle.stp
```

A difference means either a code change or a corpus update; `../test_corpus/README.md` records the corpus versions the
logs were made with.
