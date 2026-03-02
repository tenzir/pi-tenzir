This release adds a new OCSF skill for schema lookups, enabling questions about OCSF classes, objects, attributes, profiles, extensions, and event normalization without web fetching.

## 🚀 Features

### OCSF skill for schema lookups

The new `/skill:ocsf` helps answer questions about OCSF classes, objects, attributes, profiles, extensions, and event normalization. It reads the OCSF reference documentation bundled with the `tenzir` skill, so no web fetching is needed.

```
/skill:ocsf Which class fits a failed SSH login?
```

*By @mavam and @claude.*
