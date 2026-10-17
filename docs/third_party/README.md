# Third-party reference documents

Specifications this project reads but may not redistribute: the Siemens JT file format references, for the planned
JT importer (see the JT sections of `../architecture.md` and `../initial_analysis.md`). Only this README,
`pull.sh` and `.gitignore` are committed; the documents are git-ignored.

`pull.sh` (runnable from any directory) downloads any that are missing and writes a `.txt` next to each PDF, for
searching. The text comes from pypdf 6.21.0, installed into a local `.venv/`; it needs `python3` with the `venv`
module, which `source ../../env.sh` checks. With that pinned version, the text matched the copies made on 2026-10-16
byte for byte.

| File | Source |
|---|---|
| `JT_v95_File_Format_Reference_Rev-A_tcm73-111987.pdf` | JT v9.5 Rev A. Siemens no longer hosts it; the copy is from https://ww3.cad.de/foren/ubb/uploads/Rainer+Schulze/ |
| `JT-v10-file-format-reference-rev-B_tcm1023-233786.pdf` | JT v10 Rev B, https://www.plm.automation.siemens.com/en_us/Images/ |
| `Siemens JT V10.6 Format Description Rev D 10 Feb 2026.pdf`, `PMIPropertiesStrings_alphabetic_list-JT_V10_6.xlsx` | JT V10.6 Rev D (10 Feb 2026) and its PMI property strings, one zip from Siemens's CDN (URL in `pull.sh`) |

Siemens permits writing and distributing software that reads JT data, with a copyright notice; the terms, including
that the documents themselves may not be redistributed, are summarized under "License terms" in the "JT notes" section of
`../architecture.md`.
