# Sample Datasets

This project does not include large COPC datasets in the Git repository.

Sample datasets can be downloaded automatically using the following commands:

```bash
npm run setup
npm run download-samples
npm run download-samples -- autzen
```

`npm run setup` verifies the configured file size and SHA-256 checksum of the Autzen dataset used for validation.

The Cesium development server serves files directly from `samples/local/` through same-origin HTTP Range middleware.

When deploying to a static hosting service, a separate copy of the dataset can be placed under `apps/dev-viewer/public/samples/`.

**Default storage location:**

`samples/local/`

The list of supported sample datasets is maintained in [datasets.json](https://github.com/mors119/copc-adapter/blob/main/samples/datasets.json).

**Dataset URL availability as of June 29, 2026:**

- `autzen`: `200 OK` — Public S3 object; available for download.
- `sofi`: `200 OK` — Public S3 object; available for download.
- `millsite`: `404 Not Found` — Unavailable for download at the currently configured URL.
