---
title: OCSF skill for schema lookups
type: feature
authors:
  - mavam
  - claude
created: 2026-03-02T17:38:14.212225Z
---

The new `/skill:ocsf` helps answer questions about OCSF classes, objects,
attributes, profiles, extensions, and event normalization. It reads the OCSF
reference documentation bundled with the `tenzir` skill, so no web fetching is
needed.

```
/skill:ocsf Which class fits a failed SSH login?
```
