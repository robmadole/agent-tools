Before each `record` call, capture the page and attach it:

1. `{playwright tool prefix}browser_take_screenshot` with `type: "png"`, `scale: "css"`, and
   `filename: "{run dir}/shots/<slug>-<n>.png"`
2. add `--screenshot {run dir}/shots/<slug>-<n>.png` to the record command

`<slug>` is the scenario name lowercased with every run of non-alphanumeric characters replaced
by a single hyphen. `<n>` counts the steps you run in that scenario from 1, Background steps
included — it only has to make the filename unique, nothing reads it back.

Screenshot **every** step, including assertion steps whose page looks identical to the step
before. A filmstrip with holes in it is worse than one with repeated frames, and a missing
screenshot is indistinguishable from a step you never ran.

Use `png` and `scale: "css"`, not `webp` or `device`. PNG is lossless — designers open these
at full size to check pixels — and on flat UI screenshots it is also the smaller file.
