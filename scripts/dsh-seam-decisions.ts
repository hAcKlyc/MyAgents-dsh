import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { childCli } from "./child-cli.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

export const DSH_SEAM_SOURCE = Object.freeze({
  repository: "https://github.com/deepseek-ai/deepseek-harness.git",
  commit: "639ed015397290b3745d163aafe02ffee4aa3f84",
  tree: "ac66a6a3e77f6fa396509ddfecc7beacf0cf642a",
  declaredRelease: "0.2.0-rc.2",
  executablePackageAssociation: "unproven",
  files: Object.freeze([
    Object.freeze({
      path: ".agents/notes/implemented/architecture/2026-08-31-explicit-agent-runtime-identity.i18n.yaml",
      blob: "c28606ddd1fb2bcdbb4773f37096581510fd4624",
      sha256: "932b89809ac3815939880f02f41e926a44c498258f9d1d266cf173a31eedf406",
    }),
    Object.freeze({
      path: ".agents/notes/implemented/architecture/2026-08-31-explicit-agent-runtime-identity.md",
      blob: "f52b8ec116c312a27306fe73dc0bd5b99fcd9039",
      sha256: "661b115db5cf3e9c96ef821458798e06cebd95063c98e9a212c2495ce87f5be2",
    }),
    Object.freeze({
      path: ".agents/notes/implemented/architecture/2026-08-31-explicit-agent-runtime-identity.zh.md",
      blob: "6b6fd2f2ea1f1645069264f09fd53c3f71e1d02f",
      sha256: "5bd57b8a91cdd46d3b6ac916f4b1b68b82166ce7c1299ada3b95bdb9c462f771",
    }),
    Object.freeze({
      path: "docs/architecture.i18n.yaml",
      blob: "5e0e5f9848d23b73a7c2c0cdd661fa785d50152f",
      sha256: "67b688c254ae39ca7ef676c12c0d09ebbf13e4cb215019adfe3aefcb8435c005",
    }),
    Object.freeze({
      path: "docs/architecture.md",
      blob: "c63a75cb2367b566eea5778fc50273ff67dc8bcc",
      sha256: "cf5728e0b907b8c770b637f779feb785ceefe5017b59aa2e160d488ae376fc0f",
    }),
    Object.freeze({
      path: "docs/architecture.zh.md",
      blob: "1ae1356a74157fc300d7b1da44056758f52f040d",
      sha256: "1bd164bc5cd857a9c46e97d7927f40b6fac0217cefbbb35a5945610126b88048",
    }),
    Object.freeze({
      path: "docs/config-catalog.i18n.yaml",
      blob: "355b83b670d3fde0de94eac995ffba8636225888",
      sha256: "40f148c047c3700525caa5aaa4979969bbc79be6418a08c8a965d7e7d5596b2e",
    }),
    Object.freeze({
      path: "docs/config-catalog.md",
      blob: "7c40fad9136fdfa003ba430f3fa3f5467d29b1c6",
      sha256: "2051bc75e07acfd088ba00ba4ec72e7bfcaca7c0a4aab4f7d26ddd37a344a227",
    }),
    Object.freeze({
      path: "docs/config-catalog.zh.md",
      blob: "44b5a7345587d0d0b584854bd1fa7e413d05ec31",
      sha256: "e40deff653367c338a8c8aa77c6df61d3993a20d3fc8fb6f853a2c501e8b2d29",
    }),
    Object.freeze({
      path: "docs/event-producer-consumer.i18n.yaml",
      blob: "f419955c5696b84afaa5db878b0b0ffc205d0d55",
      sha256: "f6771136aae1caa86b5cf526b54c9894f28f061772b73f9f3408d56d75db0dd4",
    }),
    Object.freeze({
      path: "docs/event-producer-consumer.md",
      blob: "c2b882cd95b03f004c93cc30a9794cadec5e1d9b",
      sha256: "273e9357b71818fe519785791945e4ca7c0f3c7cef46d5c75fe46cc665054856",
    }),
    Object.freeze({
      path: "docs/event-producer-consumer.zh.md",
      blob: "97e2cb197b31d965f848895ae02be03afe42f2e4",
      sha256: "6fde648c8e0eeb1858c46fde536ec65d7fa657e3120f523d38cade68f6a9837e",
    }),
    Object.freeze({
      path: "docs/persistence-catalog.i18n.yaml",
      blob: "555c6e52a78d21d208e103035894f7fd85f74368",
      sha256: "5c629208abce7f9a67de13ed5eec8275bdb2b2e193b9bfdbe2024bd00111ecf4",
    }),
    Object.freeze({
      path: "docs/persistence-catalog.md",
      blob: "1575e2104d3c8c1ae1c3b8ced0535415b32789f5",
      sha256: "7884d96ec60e78fa0812e8b50c6949df2fba701f022ebb71be1d76aa07664f52",
    }),
    Object.freeze({
      path: "docs/persistence-catalog.zh.md",
      blob: "6bdbb929825c6300a9a2b33605d96b81510a5f1a",
      sha256: "bc21360d07498190dde6d30099c7c9c8ff6d30b6d3d3287be08729266c4fa23c",
    }),
    Object.freeze({
      path: "docs/subsystems/compaction.i18n.yaml",
      blob: "b4be04a060044598bd77c5a7a23ff1995eb3bd10",
      sha256: "cd26e017e3b14e4dd6a53fb62ce442dacff90822825d08b3edb452147088c5f7",
    }),
    Object.freeze({
      path: "docs/subsystems/compaction.md",
      blob: "6e135025ab6095e2365e172847bc493d41c50774",
      sha256: "a788a95291714b8c14d9c9b2a968bfc813cc2c53cb9784bdd06a6378c09f8588",
    }),
    Object.freeze({
      path: "docs/subsystems/compaction.zh.md",
      blob: "9b82fb7a7b9e55f2aefa6d561922948fd328c8e9",
      sha256: "0504244bf2867538544eb108d8afc8ebe7bc1ea41d25ab634214bba39b477047",
    }),
    Object.freeze({
      path: "docs/subsystems/core.i18n.yaml",
      blob: "c4c106c066488b9f923a6dfb389e908ea8d09a27",
      sha256: "739cada2af6365e668618941ce464b94c5d9856c3a13e8827ccd0156ae7633f0",
    }),
    Object.freeze({
      path: "docs/subsystems/core.md",
      blob: "15c70ebca6a1469634ca75450c23097990e85037",
      sha256: "b4a1d0432308ce03d6d86bb9fd5007b95988a22fa0850e033bef1e4a6f010601",
    }),
    Object.freeze({
      path: "docs/subsystems/core.zh.md",
      blob: "03de9ddb7bb1eab82a60b6026c9864531f4bb1e1",
      sha256: "5d9716fe982a305c31aa83097dc63a1d0dac787580f6de7ffb21d759a56756b8",
    }),
    Object.freeze({
      path: "docs/subsystems/session.i18n.yaml",
      blob: "e4269bb273eb2b286387fc699a84ed05a2b8efd4",
      sha256: "4b14cb51142cb9d25ee77a1cd732f1749195f0fd904a910fe387243ba9e169dd",
    }),
    Object.freeze({
      path: "docs/subsystems/session.md",
      blob: "415201d15987b8369b2f5bfced3dc18dbc89d1b3",
      sha256: "f5cb5d264af992ca90b13b01de650bdaac255b9c2b8e4c8e59b23748545a879e",
    }),
    Object.freeze({
      path: "docs/subsystems/session.zh.md",
      blob: "e52c08e8199caddc6dd6761dddb0c3da82680aa1",
      sha256: "01e0330cb6cd3a0667f21b197d3d13e3aab3ef6cb47a9a633e7ddfad75cbd06b",
    }),
    Object.freeze({
      path: "docs/subsystems/subagent.i18n.yaml",
      blob: "5b6c01d39a4eb281cc682a758e140b5f9cad3c3b",
      sha256: "df520dad1725a911af9a89f1696843d777d3b074f596011c89075dad8ed71af9",
    }),
    Object.freeze({
      path: "docs/subsystems/subagent.md",
      blob: "de96d7550904fb99e9109946c73eb1122dc4bdad",
      sha256: "5387e4a9f057da4951cea6b0917704504b36ceb83e9b9a8d58467dd07af1ca34",
    }),
    Object.freeze({
      path: "docs/subsystems/subagent.zh.md",
      blob: "843f0e0cd7149e5ddbef9414632fa4464f58882c",
      sha256: "5e4506efa0d42fbd4cf1a1ea115494490b1b27f812b880a314f5567da051b303",
    }),
    Object.freeze({
      path: "docs/subsystems/system-prompt.i18n.yaml",
      blob: "e11fef3eb7dc1f696e09dcd46818c9c887ee21f5",
      sha256: "bae06bedea5bea06e119e8933fb18baf08e84f8bff09595b67dbb4bfcb75912a",
    }),
    Object.freeze({
      path: "docs/subsystems/system-prompt.md",
      blob: "898520e8fc88a9fafd8429723fc48bad3b4ba210",
      sha256: "2c652615dbee5a082fc0875e6caf7bacc81c0f44bf08d888057f98bd77bb06c8",
    }),
    Object.freeze({
      path: "docs/subsystems/system-prompt.zh.md",
      blob: "82e557a309a48f546d7c7fa5a8c1097152b4d145",
      sha256: "01b069941e965f86a612703fef3fee18ac7743db15a30c5614f1994c9f401eb7",
    }),
    Object.freeze({
      path: "docs/subsystems/token-meter.i18n.yaml",
      blob: "1e666632b58ded9ccb03ee64865578521747f386",
      sha256: "cdfb98d85225ae0a79518f46098092b21845e3f06a4e787dafe8a95122da0dc1",
    }),
    Object.freeze({
      path: "docs/subsystems/token-meter.md",
      blob: "8accb9cf9f0b97ee7684e327da336a31943ff49e",
      sha256: "41b6d575ba2031b0d284ff553fa6c1eb0cd521f415a3550f85960d21bff57fa2",
    }),
    Object.freeze({
      path: "docs/subsystems/token-meter.zh.md",
      blob: "6c149ec3f225a7012ca8d8d2312835663917b5d2",
      sha256: "320378b4c78881a7f3ae2a877a90dfd11479fc6a335391aec2ff5f50ba5323d4",
    }),
    Object.freeze({
      path: "package.json",
      blob: "f5ce66dc9e112a415ed3e8d3aafbb98600daad12",
      sha256: "a303ffb8994be8e7a874bc887db1abd47a77a6e08872e65f1d65281f43eab91b",
    }),
    Object.freeze({
      path: "packages/compaction/compaction-basic/README.i18n.yaml",
      blob: "aca17e342eb9a07a325b313beebf5955569c3efb",
      sha256: "bdae1bdd1947d51abfc94ccdcdcbd89a663be0f407fa38f782a786ac84148eb4",
    }),
    Object.freeze({
      path: "packages/compaction/compaction-basic/README.md",
      blob: "fa4ae2fb481296ff91f4c1df9975225bc2c51eef",
      sha256: "fec02741a265ed2872f74ee1285bc0a6462ed76264643aeafbc8cbdd81e6427a",
    }),
    Object.freeze({
      path: "packages/compaction/compaction-basic/README.zh.md",
      blob: "1cb48123cd0daf9c3b08343e57173df8b9b6bf11",
      sha256: "baec8105b836e3566b6ae010ab51913c1c6641517518d723aa0f7f1a68fc7c9c",
    }),
    Object.freeze({
      path: "packages/compaction/compaction-basic/src/index.ts",
      blob: "163cec3810e9d3a335efe6c1264eac5a00c107c2",
      sha256: "c298756c1d06a24593dc573e08f337f7f012675bcfaa675edb7d5368b19649f6",
    }),
    Object.freeze({
      path: "packages/compaction/compaction-basic/src/region.ts",
      blob: "7b3d77d299881fa47b8dfdab7fae0a92cd7d462c",
      sha256: "295b53cc9e924f7cb2e843e0d0d296e89ead73da2aab9790282db30736e2e063",
    }),
    Object.freeze({
      path: "packages/compaction/compaction-basic/src/summarizer.ts",
      blob: "2d258fa410a7a87258f8d3a45c548cde0d383014",
      sha256: "03ef6eb0b6a011530829820e30ff709c2c1b34cfa37a98c19c0037432b9d2f55",
    }),
    Object.freeze({
      path: "packages/compaction/compaction-basic/src/types.ts",
      blob: "e8160dba2c078e199a9536a9ed3eced592062077",
      sha256: "c7f961c27c04412cc405a2e80878b190a9b8cfd14b27865ec70c7a27b922a917",
    }),
    Object.freeze({
      path: "packages/compaction/compaction-basic/tests/compaction-basic.spec.ts",
      blob: "3736aa5c5e64f763606370a3cc855c5e444a7941",
      sha256: "9de39a8931bd2bb85566a7c6083f91aea03fc9cbaa7e885e8a89cc004b566fe8",
    }),
    Object.freeze({
      path: "packages/compaction/compaction-basic/tests/compaction-loop-repro.spec.ts",
      blob: "b6c8ff7f86a3a5127930aa41659917fb429e848e",
      sha256: "ac9d68e1bb20b647a2562c827d1d1d5426802d7d3723de646cf071de3336a48b",
    }),
    Object.freeze({
      path: "packages/compaction/compaction/README.i18n.yaml",
      blob: "26d64055072948a31463a7f420e6f2b152baf859",
      sha256: "ba9ffcea49bfb3c302fc4b2d2540e69c89bb45c8c05e62bf96f185f76025a922",
    }),
    Object.freeze({
      path: "packages/compaction/compaction/README.md",
      blob: "fecb3b6731108c493825f6fa0874ab865781fc2a",
      sha256: "395211aa93a0112e1fe07c1086f9c172ac0150a3583e4601a55451f196e6f41e",
    }),
    Object.freeze({
      path: "packages/compaction/compaction/README.zh.md",
      blob: "86e6a2935c408af7e247235378a022ad855c00a0",
      sha256: "7799ed05360d21bc670970020255e1b6e047c1299c4998ffd9ee71733d06bd2a",
    }),
    Object.freeze({
      path: "packages/compaction/compaction/src/invariant.ts",
      blob: "0b347a71eb4453f690891064923a5a2efa9f26f5",
      sha256: "38f160de5840d1c556f51d32b7fc7848aa17b4c65b74703f9f107b5bed116e90",
    }),
    Object.freeze({
      path: "packages/compaction/compaction/src/types.ts",
      blob: "5a7d12c1b21a9ed55287a1935a3f8104d30722b9",
      sha256: "72859150e72a6f75bd97a637f12c2488132f039eefa1ebd4294561b21ac918ef",
    }),
    Object.freeze({
      path: "packages/context/agent-instructions/README.i18n.yaml",
      blob: "572468170f8bdf78421f726c5ffeb09512299ac1",
      sha256: "1b5677603ccc48f3d7f940628aca28a0d0f3a7b170919ed09f1eca06f0f0163e",
    }),
    Object.freeze({
      path: "packages/context/agent-instructions/README.md",
      blob: "34feeb2ac5ba1f43c685321741b779bdb4d6d23a",
      sha256: "eb3481832b5ae10e2cf5a2e01869a7232d8a376224422dd686a5808a6fac4d2a",
    }),
    Object.freeze({
      path: "packages/context/agent-instructions/README.zh.md",
      blob: "311d6f636f9662142e9a70d6f5002417d69a256e",
      sha256: "9470c03602310ae9d93eb2680f436482a1e274a389b81c1a786102c9e39e5dad",
    }),
    Object.freeze({
      path: "packages/context/agent-instructions/src/config.ts",
      blob: "f9edc9d4b8d88f1141c8aebc9dfdf0494a87ee74",
      sha256: "721ffeb6743d9314f62f2636c4bd24fc9e871fafdd3a6a88f00f41fb1c1d9a40",
    }),
    Object.freeze({
      path: "packages/context/agent-instructions/src/files.ts",
      blob: "fe1816dc74e37b63e5cf50a6fb7145b6a6c35ec4",
      sha256: "261b1970cc583c09ecc5f85222a0fd1ba60ea7d962ab52cbd21f9a2a4e6529da",
    }),
    Object.freeze({
      path: "packages/context/agent-instructions/src/index.ts",
      blob: "82cd0451f31eb26e46ff899f21f939aa91fb3622",
      sha256: "bca2df91166de1b4eac099c532e6762a8f30387366097cec16a73b8078860d82",
    }),
    Object.freeze({
      path: "packages/context/agent-instructions/src/state.ts",
      blob: "61d8fa4237e0ce94a08de20ae2cff65f1ae97645",
      sha256: "4111e4e3e5a5db24257bb2190583950fcf8e5578cea4f1c5a80d81af7924e5bd",
    }),
    Object.freeze({
      path: "packages/context/agent-instructions/tests/agent-instructions.spec.ts",
      blob: "533b443256983532fde8c03d0ff0b5b28a380464",
      sha256: "7baf3cb3b10ef57d138b642bcea8fc1a2eb1b78883ca239514d89811034a3040",
    }),
    Object.freeze({
      path: "packages/core/agent-loop/README.i18n.yaml",
      blob: "787f531a3141ec9c87c6559cbff3ace4ece58c76",
      sha256: "a4b6816ac2a1c5f6cf84593d553e26ec501f0db15c4da47d7d759f29bdf737d9",
    }),
    Object.freeze({
      path: "packages/core/agent-loop/README.md",
      blob: "19e356affcaed3029b17889fc5df56f7271333ba",
      sha256: "7e85b7d46c17e5351455821e70441080214e249c2bf19ea356239bb09749e033",
    }),
    Object.freeze({
      path: "packages/core/agent-loop/README.zh.md",
      blob: "a6a8e874c06c4069e7941eeedd16d14bd43c37ef",
      sha256: "b2df762bb642f23a6fd8e378aa498f31f9c76bfd3f8c93087f9c88fc171ccef3",
    }),
    Object.freeze({
      path: "packages/core/agent-loop/src/agent.ts",
      blob: "2f68565cef052f82ef6f2a740141962507654e02",
      sha256: "9c985dd5ce3612b0a6f1833cb592930e4e390d4249821accea53064d8e42015c",
    }),
    Object.freeze({
      path: "packages/core/agent-loop/tests/cancel.spec.ts",
      blob: "add362835b44d0edc7663d94566654c47866b7a8",
      sha256: "ccec6f34e6dc8b9a2493e516a5b5aa5025ca72eb9231fc004de447850ce081db",
    }),
    Object.freeze({
      path: "packages/core/agent/README.i18n.yaml",
      blob: "19639a27c091ae2488627a595335aeec74e7ffd9",
      sha256: "5e26833005e4d19835b624e392427385769d73319cd529cfad9ce4d0f93859e3",
    }),
    Object.freeze({
      path: "packages/core/agent/README.md",
      blob: "be003d7b899306b58c4ddc88e720c18dde9ce33b",
      sha256: "e7a7d599ea893bccd66dfdd8081b46c1323a0456534eec5471b53999d8db5abc",
    }),
    Object.freeze({
      path: "packages/core/agent/README.zh.md",
      blob: "e360ba975dddc381e25b69766b1df82f6e45b3b4",
      sha256: "4832d7f77100f9622fa0cc6733a4b9a6d2be435131ac9d73a059c18d86d7fda7",
    }),
    Object.freeze({
      path: "packages/core/agent/package.json",
      blob: "121af3b02bc0e86d74832ee07073748090a42f40",
      sha256: "5a1933ae764443b0f725af0a069d810e55cb83857f0a99eaf78fe70b0ee1d01b",
    }),
    Object.freeze({
      path: "packages/core/agent/src/index.ts",
      blob: "54dd8a805dd7be26953b31cc97864900f7da3fc9",
      sha256: "9979fdae64fd0a342067981c39de9cde2da7066d28f8506a501fd51e8f9068b9",
    }),
    Object.freeze({
      path: "packages/core/agent/src/runtime-types.ts",
      blob: "2118507b8cc617a920e7ceae9f98d06daa2d4780",
      sha256: "d0ac3509febb04308eff84bc6c949ff3c736dec9fd9f8d230c5d7fa3455ff204",
    }),
    Object.freeze({
      path: "packages/core/scope/README.i18n.yaml",
      blob: "0b818aafe7a74388dc22986268de8604d3ff0460",
      sha256: "d79b438cfc7c5ce83c6010b93722891b50113948cd644b1eea79f85d8858ceba",
    }),
    Object.freeze({
      path: "packages/core/scope/README.md",
      blob: "72c41e4c1a3b8f8a79940838ead7447f64781cc4",
      sha256: "23689d3f56b588dd5848c5d03d70e70326d777dc0ae7705327f6e380d432c4c5",
    }),
    Object.freeze({
      path: "packages/core/scope/README.zh.md",
      blob: "b48842570c564979f920d8e6f6fda87284f4bc65",
      sha256: "a5e0aaa5fd196235a20ebfa6ada6cde8b591326618be076df7dc9ecca9d1a040",
    }),
    Object.freeze({
      path: "packages/core/scope/src/scoped-events.generated.ts",
      blob: "d0e4a9cb9727c492a551a8188454bb58820507e5",
      sha256: "7d575021ad9e564f3910ea3fb055d1f40065586512d702a5454fda64678b2cd5",
    }),
    Object.freeze({
      path: "packages/core/scope/tests/invariant.spec.ts",
      blob: "8e3e358a2743a6f84b2c40decbb338e208124c7a",
      sha256: "3e4cd37a906ff92bb24ea00759968b6a36e644091116be991b3494f1b050f0b5",
    }),
    Object.freeze({
      path: "packages/core/session/README.i18n.yaml",
      blob: "d2ab139d2c1ee536c0235dd6a4322c1bb7a20931",
      sha256: "cffa2ca14c10bc52e3032c9124bacce3946360a541a8403c02c032f1584658d6",
    }),
    Object.freeze({
      path: "packages/core/session/README.md",
      blob: "4a73a20c95d2ad05c4d5b432beedb7dd7bc14eda",
      sha256: "d8d75f10c9378c4bc5085016c982a2c0dd46c9bd9eeb8b9ccc18a4a8449e3759",
    }),
    Object.freeze({
      path: "packages/core/session/README.zh.md",
      blob: "7fb334cfaa8a3a5468bf8330f0dd5802d1e98dbc",
      sha256: "b27f53bccbc5141326c20e6ce0e101f96f4d6738ae7c62d404b594967b85fcd2",
    }),
    Object.freeze({
      path: "packages/core/session/src/index.ts",
      blob: "b0cfa0c19b6ad65404fcde055af8e318632ee705",
      sha256: "711d4d071bdce9afb4ab2abcf36b5dfc79e4a956b3236aa880c8c019d73ab9e6",
    }),
    Object.freeze({
      path: "packages/core/session/src/known-event-types.ts",
      blob: "adaca29255a181c793a73476baddc25324083cb2",
      sha256: "f70489f767e4996c482cc7624edbbc93bf71a7d84a1bce94b587016dfa8d073c",
    }),
    Object.freeze({
      path: "packages/core/session/src/tool-history.ts",
      blob: "90c28dab06aedda41dbe60cc93481551ca3dc392",
      sha256: "53ae6aebe5ebe9b1eb782f008315db33ff637611093e40fa3529ec3019b56683",
    }),
    Object.freeze({
      path: "packages/core/system-prompt/README.i18n.yaml",
      blob: "d05e3b8c576f11b9d4f5e82f6e4ce1f6a73ccae6",
      sha256: "16ca1eaf1764ddd9ed23c2c0618485aa46b3ad1a38bf5e9079727826138f8be0",
    }),
    Object.freeze({
      path: "packages/core/system-prompt/README.md",
      blob: "a76ae5c66f0801cb85cd8cf22d0c3ebbc68e65b8",
      sha256: "d31b5a9a87233228d7d097134d7f7665216ab03dc478a10a47f48027a4ca5721",
    }),
    Object.freeze({
      path: "packages/core/system-prompt/README.zh.md",
      blob: "98c6e733399c954c5bbc56b905aefcc6b080381d",
      sha256: "48442370f5c0aa03028aeaa0c09904502a04c2b7cff847137f0bda8ce2acf012",
    }),
    Object.freeze({
      path: "packages/core/system-prompt/src/index.ts",
      blob: "6935ed1d062fc7f5c0e1e031020ab863aa0b4d79",
      sha256: "9e31442544109b3ff9be13458e826e0dcacbe31d9f59ddd96a6498ab20b1574e",
    }),
    Object.freeze({
      path: "packages/core/system-prompt/tests/system-prompt.spec.ts",
      blob: "16a79c807f4da6a86bbe8cdf603ae71c80bc7c49",
      sha256: "e06af2fa546860eb96cb6436a66acb10863f5350da32494b9db33478eb7175bc",
    }),
    Object.freeze({
      path: "packages/extensions/tool-cordis/src/api-catalog.ts",
      blob: "a7043c75efcca854016a4e44cf980c82712dde39",
      sha256: "4a5098979f529cd2c9f09f961837dee68bb10b7d884d3b115d3008c15d64e7bd",
    }),
    Object.freeze({
      path: "packages/fs/fs-local/README.i18n.yaml",
      blob: "c82192ba902ad1e4891b413af541f2be123832db",
      sha256: "8b9675677c2bb50058d1494766b401aac905b84ba89eab0b20e61d8c86818002",
    }),
    Object.freeze({
      path: "packages/fs/fs-local/README.md",
      blob: "9c005443eb064a03b3050c9ae82295c794315239",
      sha256: "ad1d8168cab427cc42e06710b93350ff7e175b8ac43541b191287e38aead0320",
    }),
    Object.freeze({
      path: "packages/fs/fs-local/README.zh.md",
      blob: "3adc249afe68b4cd8b56c68101baafec47ffb981",
      sha256: "07c35266962b5ebfb2dceb2fbc5dbacb1bf97bcc4c91fcc3f4f7471e4f5e996c",
    }),
    Object.freeze({
      path: "packages/fs/fs-local/src/fsio.ts",
      blob: "a9d97fd6ac2402de6c38712df13a47b348db5350",
      sha256: "d7cc70e0a8b06981b94e1ca64963f956f939892c4ea0399e282be5427c42778f",
    }),
    Object.freeze({
      path: "packages/fs/fs-local/src/index.ts",
      blob: "17033e512ba83eff50327419610f2aff568cb872",
      sha256: "77cdf3a1a259c9e24fef28f42f937a6b5ce1ad6d692fbc8dab148925cc4f1f28",
    }),
    Object.freeze({
      path: "packages/fs/tool-fs/README.i18n.yaml",
      blob: "90d4a216dded277d06ba0ca783ca9b83d0f9fb35",
      sha256: "58988218327d2a089725033a141f952cc6949c678649b97639a2f06abe9c46cc",
    }),
    Object.freeze({
      path: "packages/fs/tool-fs/README.md",
      blob: "a6e889f1d619537dc77afdd05b12d37e6d51858a",
      sha256: "f3cc90cd31da1613df826fe47c1a16030aea6866f5412a62af1eedfed8173927",
    }),
    Object.freeze({
      path: "packages/fs/tool-fs/README.zh.md",
      blob: "5e56478d929f7890f47fa10963f5bd55b3bacb64",
      sha256: "a532f31b90308f28208bb16324f4da4aa046f3baf71da56c3223492800f6853f",
    }),
    Object.freeze({
      path: "packages/fs/tool-fs/src/edit.ts",
      blob: "643806a96a41920ece814aea7bbd91334c1dc921",
      sha256: "7a1cfb9e4b6e1e83cb86b33a08a1b5d23fe6a5a240659afac1e1499b4dd5e4db",
    }),
    Object.freeze({
      path: "packages/fs/tool-fs/src/index.ts",
      blob: "cfbec13cda610efd9ebb1cb6ea8a7ea2c5821d63",
      sha256: "fde2a282c79d76fd83c0704ad2e89cd79fcabfe81aeb078859b5934b577a3585",
    }),
    Object.freeze({
      path: "packages/fs/tool-fs/src/read-image.ts",
      blob: "c732750921c3356c7ccd8b9eb76919d59565144e",
      sha256: "e8c6ab79e4e24e302ef8e3b52fed5c35e254e4d2b55cd14a90ed48ea0cb267be",
    }),
    Object.freeze({
      path: "packages/fs/tool-fs/src/read.ts",
      blob: "edc273e0bef8530a84026bad2a43fb359e212536",
      sha256: "1e7d5743be73623b07cde79f2f7168f4466794c26c714b923c289cd0e155115f",
    }),
    Object.freeze({
      path: "packages/fs/tool-fs/src/sandbox.ts",
      blob: "6b815e5743df1f9ad5c8829305dfc868aef29382",
      sha256: "c3b16a63c64e0d921f18d0ba76ca6eadb7d88b61edd852eeb9f63fa90c5a7f89",
    }),
    Object.freeze({
      path: "packages/fs/tool-fs/src/write.ts",
      blob: "405a1138151ce20aade896886844cd6a8a6ed8ac",
      sha256: "c79dfb2f270a52df96c87547a8370e4561ac110596a83db909477da38f884d8f",
    }),
    Object.freeze({
      path: "packages/interaction/user-approval/src/types.ts",
      blob: "12b8106d3460c80f952a754b4420c6dcbfb217c2",
      sha256: "4413da55040e100e5700b5b89dccf387e08275587ac21876cba8cbab2df34037",
    }),
    Object.freeze({
      path: "packages/llm/llm-deepseek-api-key/package.json",
      blob: "c9c762a0a23e159d42e4774d5f6c5d46fc5aacc1",
      sha256: "bdd86a7a4488400d30c1819eadc00b74da4e363216bb4e550eeaeda750330979",
    }),
    Object.freeze({
      path: "packages/llm/llm-deepseek-api-key/src/config.ts",
      blob: "4046483cd76ce9e44302860480ce2e692ea02403",
      sha256: "b6db143c0ccb3d61af975b48779f5d9e0ec9eed3b27a81048c0104a7d667b503",
    }),
    Object.freeze({
      path: "packages/llm/llm-deepseek-api-key/src/index.ts",
      blob: "cf039f9a0ab9f424796b2bc2c3c857641f8f3ba6",
      sha256: "16ccb29fc5feee3778f7fa86af16693c175844b2b74b4aad0218288e7e670170",
    }),
    Object.freeze({
      path: "packages/llm/llm-deepseek/src/host.ts",
      blob: "cbe340c5165c9cde7382daaf3ce1e79503c00b54",
      sha256: "41661b74ab93198ad37945ef7933de92f0d7738ec33fe67f4d733eb80f745fcc",
    }),
    Object.freeze({
      path: "packages/llm/llm-deepseek/src/translate.ts",
      blob: "deb901119ee8308f2fe1420222dda0ffdf6b7cbf",
      sha256: "254f4b8fe292dadc5c24df3375b01920f5e5b345be09eae4290e91e9e810c1ba",
    }),
    Object.freeze({
      path: "packages/llm/llm-deepseek/tests/stream.spec.ts",
      blob: "aa86d4840460a3b8ce16791af5d8161a9cd63ec3",
      sha256: "0df1ef959aa0e083e4c27980105f117cd41dd9d6f121574f15dec8aa4c82ede4",
    }),
    Object.freeze({
      path: "packages/llm/llm-pi-ai/README.i18n.yaml",
      blob: "19311117b679bda1dd4d1dfe6ad093afa6cfd777",
      sha256: "be0421c6d807662a7f1895e3dcad8f0cf3dccd6a2af2e98d250807a45cc46b46",
    }),
    Object.freeze({
      path: "packages/llm/llm-pi-ai/README.md",
      blob: "0e8a801b5354f050b98c0575da8b373e1431bc60",
      sha256: "9d0e389fba40dedec1d7199f0148fd527163400a440d291a0e5ee962e8f2bf5f",
    }),
    Object.freeze({
      path: "packages/llm/llm-pi-ai/README.zh.md",
      blob: "5126fe25ed6fe4b431a74ddc0d21abd4a6d72861",
      sha256: "75d6a38c8afe995b963dbe72999c5e1ee14bbfb9af6a8e56848b7be59d3a7cb9",
    }),
    Object.freeze({
      path: "packages/llm/llm-pi-ai/src/replay.ts",
      blob: "9012c56fcafcb7f00690d59a5942e327c65e9fbd",
      sha256: "436e19859cb32c299bb7e4ddd15557b083fb285be73a0a48e3c8a95fce7a690b",
    }),
    Object.freeze({
      path: "packages/llm/llm-pi-ai/src/stream.ts",
      blob: "30e9c79412a300adc8a373b1a5e2caa77cb69ad6",
      sha256: "e3563cc091cc2e6b0c2bdbd4c1614339d7cbb01f747a956931b43f3256e0c640",
    }),
    Object.freeze({
      path: "packages/llm/llm-pi-ai/tests/convert.spec.ts",
      blob: "005c12596cd7d765f1992cdcab808f859d4afdb1",
      sha256: "08175c982134af9f4003591e71793975f9cdfc8294d554575cd0116546aef279",
    }),
    Object.freeze({
      path: "packages/llm/llm/src/content.ts",
      blob: "cecbfba938926da0c4fc821d95a07ddda5dee0bd",
      sha256: "e679f0972cef3f6301c4a9f321ee288ef0a63223ec51c093349c186cdc81ff35",
    }),
    Object.freeze({
      path: "packages/llm/token-meter/README.i18n.yaml",
      blob: "161e2e398885e0e2ad0af851cb648faec19eb25c",
      sha256: "c46ccf06219613b0d0d9b9bb36559bec7daa5934352474b8662ae113263e9636",
    }),
    Object.freeze({
      path: "packages/llm/token-meter/README.md",
      blob: "e6d957bd14560d967fb221b147d87d7db42197ea",
      sha256: "dfe1d33db96248d1c37c243bdbf28b9d92eb15f36025648ef50a230b40fc5e4e",
    }),
    Object.freeze({
      path: "packages/llm/token-meter/README.zh.md",
      blob: "526be7b2e399bcf6f4638ece9a7315044fa48c55",
      sha256: "132127118a460cf028b7a3e0db78d3a131e9a8c82ebfd6f69582ffe4c4d6b0e4",
    }),
    Object.freeze({
      path: "packages/llm/token-meter/src/estimate.ts",
      blob: "ca54abf6b225a251dad09d61cbcbc90dea57dcd2",
      sha256: "30ecc576a77aa3a65fb8173c551e13d7651ddba2d7bbd907845a003f17ee189d",
    }),
    Object.freeze({
      path: "packages/llm/token-meter/src/index.ts",
      blob: "f721d26219e827b9e8ffc4ace839ccbf9a72351d",
      sha256: "9d399314121785154296af650c6059bfd967a4ba6fc72299aadf8a2dce3f7ce1",
    }),
    Object.freeze({
      path: "packages/llm/token-meter/src/surface-fold.ts",
      blob: "29df77f87a60e0dc237d771c9f613d807fabe389",
      sha256: "ee5e0dbe6f6782f765b670ffeee09db3e6cf18808530db476621d12853cfc6f1",
    }),
    Object.freeze({
      path: "packages/llm/token-meter/src/types.ts",
      blob: "487e031385da91e4f900ce3bf471f7bac791e6b5",
      sha256: "d0c153b4ff135839c072b1c57056366003028fb2f5ba7ea745845580c5fcb08f",
    }),
    Object.freeze({
      path: "packages/llm/token-meter/tests/route-pricing.spec.ts",
      blob: "bf11f1b039ca54d6305f3b8bdbd7b01f46ff7de9",
      sha256: "c35589ac8f451d53e3f5dd502f2c2d21cb4b5accf69c0b8232c45d25e3da09b9",
    }),
    Object.freeze({
      path: "packages/session/session-persistence-jsonl/tests/current-event-admission.spec.ts",
      blob: "b7cbb7e6ee0dbcd9d20823cf00fe67bfb2224d0d",
      sha256: "08c8008f138bf58d2601cf8c80154c6ba8f4dde4937ac909aab4481bc1ef8f87",
    }),
    Object.freeze({
      path: "packages/session/session-persistence-jsonl/tests/lease.spec.ts",
      blob: "f43af72681c396a027feb0a2e540635d0e7c9872",
      sha256: "abd29bb86f5b65b328ee68f63b6361ab60e955a4284fc7cc3b16039bb2537472",
    }),
    Object.freeze({
      path: "packages/session/session-persistence/src/handle.ts",
      blob: "b6a194c87d14b787df55452e50f0008b3f56337a",
      sha256: "2fd8b5c5188ffdf5adee78a260b3dd0a9be97e5eb9fcdb5aafae5a8ed5471a31",
    }),
    Object.freeze({
      path: "packages/session/session-persistence/src/index.ts",
      blob: "80b344c4e9a9d2aa8649867b09648ab56113add9",
      sha256: "ac78517e2518f7baf00b4353944b96bb8040ee1edd9f2986ab663842eb763cb0",
    }),
    Object.freeze({
      path: "packages/session/session-persistence/src/storage-contract.ts",
      blob: "172a59a25829235d117ef767296a8e244f721ce3",
      sha256: "062911ece08832418f2fd0dc8fabdd8848897de6b2d97bc7fca54a634e0c99bd",
    }),
    Object.freeze({
      path: "packages/session/session-persistence/tests/storage-contract.spec.ts",
      blob: "2f34cd384f60217e4b4c5be44a03bc882445a0bb",
      sha256: "09726bddef0e2b31fe104a719e44c88a9dc8584147ce81de8647f4a1c20a1f55",
    }),
    Object.freeze({
      path: "packages/subagent/subagent-fork-in-process/src/index.ts",
      blob: "0e69915b60a339b7b3b03747566fad5f9497b4c8",
      sha256: "7e6d4ca3e668541f16b660bf06e1557ae4cb069f47b98ca3b0f66751226abb03",
    }),
    Object.freeze({
      path: "packages/subagent/subagent-fork-in-process/tests/subagent-fork-in-process.spec.ts",
      blob: "2f34a7d35990e918e9e87f7766dc0b9fa3c42a2b",
      sha256: "735829eac1e11f3d84b66b85497377cce54411301f2823a10a3d116f90492925",
    }),
    Object.freeze({
      path: "packages/subagent/subagent-in-process-driver/README.i18n.yaml",
      blob: "0652ba509c6d25fd8f8817781a954dc64b3ac82a",
      sha256: "39675000b2995979cc361f13ffd2dec188cfa720d69d97c2da1fbee12d4e6d90",
    }),
    Object.freeze({
      path: "packages/subagent/subagent-in-process-driver/README.md",
      blob: "fe9703a2bc735cfea81dbf921488edb786335f6f",
      sha256: "a3d791c031fc02adb091f9db1bc22f0d0ecf6a87cd308fefb6b7c790cc0d3d5d",
    }),
    Object.freeze({
      path: "packages/subagent/subagent-in-process-driver/README.zh.md",
      blob: "5ee7447829985b71d7f2004bfaa94a98fc187ea1",
      sha256: "2f210710510d29d463f78ca4e4c238896701bf56d16e53b24657ce6d852a1276",
    }),
    Object.freeze({
      path: "packages/subagent/subagent-in-process-driver/src/index.ts",
      blob: "dbaac326b10c444c6509dcb9f1aabc5f4f87df02",
      sha256: "f341e02933336ba974c5c48b4d57aa893c80b7d0009c37489a320971efddf921",
    }),
    Object.freeze({
      path: "packages/subagent/subagent-in-process-driver/tests/subagent-in-process-driver.spec.ts",
      blob: "3c50c9debfcad82a437b12e6229b50a16c419fc0",
      sha256: "72db84f4ca5308e417c91cc267d1f3060b72d49fd4234e7ce81482cad10d2669",
    }),
    Object.freeze({
      path: "packages/subagent/subagent-spawn-in-process/README.i18n.yaml",
      blob: "252819dbfbe2dcbaa95b76fa77a3b15dd6697429",
      sha256: "15550ff7df82fe9762e49465413f9708359f3e62679f4b6f4479f8f9db9ce13d",
    }),
    Object.freeze({
      path: "packages/subagent/subagent-spawn-in-process/README.md",
      blob: "ce3909934efa1b2f5cc57ff046b892e3ec129444",
      sha256: "12dd5766275d8a8b7a571140c9fea8de37b5eab0c8402374b2f005d364612e15",
    }),
    Object.freeze({
      path: "packages/subagent/subagent-spawn-in-process/README.zh.md",
      blob: "998b90ff0827e3cccc3be787e1941ca49aaeec0e",
      sha256: "0480581a55e2e2a38190a7566defa862e716095ca24544bcff466bbfb17840e0",
    }),
    Object.freeze({
      path: "packages/subagent/subagent-spawn-in-process/src/index.ts",
      blob: "73811155c1979f5328309b106dfe53a961ede7c9",
      sha256: "0401c302d49b44a779d1e6ba93f817f43a8fe67974840c432d881792ff14fe66",
    }),
    Object.freeze({
      path: "packages/subagent/subagent-spawn-in-process/tests/subagent-spawn-in-process.spec.ts",
      blob: "e199b7c9aad008276348649cbb4d81a4421a9730",
      sha256: "add9e11d6c2156fd2866e1a37d697b285c1ef9349e5a7141aa0657b1141466f5",
    }),
    Object.freeze({
      path: "packages/subagent/subagent/README.i18n.yaml",
      blob: "787865254c557c26392825f58559a6203938ac35",
      sha256: "1aef58dda599e789afe5e6500d3f5369378f591d2dcf2eea067c30fb20865cd3",
    }),
    Object.freeze({
      path: "packages/subagent/subagent/README.md",
      blob: "f962257a854893d94d5b9317c9605d952917b1b1",
      sha256: "2f8c6f5868898dccab2c620b78755babc159f04ad617e95c1a85dfa30394e6b4",
    }),
    Object.freeze({
      path: "packages/subagent/subagent/README.zh.md",
      blob: "0e347bab44a082095e62b2fbd88d0e0508524101",
      sha256: "d59cf1f7b03875b6914aacb06fa0a885fef214d6f09a3959fe93fc588094f25e",
    }),
    Object.freeze({
      path: "packages/subagent/subagent/src/child-agent.ts",
      blob: "0004567a30f5f9e50a91518c071ed87ce72ae671",
      sha256: "4010d3c8399452fc02a033f789fca1869d64fa49892e22c10e64d4590e0aacdf",
    }),
    Object.freeze({
      path: "packages/subagent/subagent/src/continuation-activation.ts",
      blob: "d995e9f2b4adb13ec7ac9751f085cac7a2409a24",
      sha256: "b7e407e9f25d3057dacd7b7dcd68e8d2fa246d0765c46bcf5ce3963e09a18a61",
    }),
    Object.freeze({
      path: "packages/subagent/subagent/src/continuation.ts",
      blob: "87fae7096a7dcaf05601f0c62f40ab28717005da",
      sha256: "b9224fd93929a54701b22e500837805091132f8d6a7f30c358ae0c58cd4e12de",
    }),
    Object.freeze({
      path: "packages/subagent/subagent/src/descriptor.ts",
      blob: "de9191cc50fff632e3a9ff1c61e14a534df961a8",
      sha256: "00b5dc5d259f78ab9fb66cf7aa4f1c08835f471f2379e6fab79f7e03791c614c",
    }),
    Object.freeze({
      path: "packages/subagent/subagent/src/index.ts",
      blob: "6654c1c0e5d056ed0f4c76a56ca2a9536b1ff24f",
      sha256: "3b895310cece7d2a1c49446d6dd52b29a4b6fc979cd55d09b194640dc199edda",
    }),
    Object.freeze({
      path: "packages/subagent/subagent/src/lifecycle.ts",
      blob: "d0ccf55b301d4eb30fd6c822785fd6e87d312505",
      sha256: "e82cdfb739f9effd8fd5db3c33278d1f111d277d7818ec3199ed40a76734d5c5",
    }),
    Object.freeze({
      path: "packages/subagent/subagent/src/list-children.ts",
      blob: "0e8e584f84d239cb3db09c8f75956eb86585da49",
      sha256: "b66b903bd38f3176ad0939f04264d7f647eea4e5e425981e8de64a12af5e289a",
    }),
    Object.freeze({
      path: "packages/subagent/subagent/src/types.ts",
      blob: "48ac0df1e18a2ee74a4865de736a55b2e1451264",
      sha256: "08b6a2f78cc95e117ca745a079cb7d77a15fb3a66292f900a0e3fe280cd09411",
    }),
    Object.freeze({
      path: "packages/subagent/subagent/tests/continuation.spec.ts",
      blob: "3078d28e71942a89f09c8a0b1f379bc25705c0b9",
      sha256: "eb43619849e054643331127debfaedc3f4c937d8442dfba17e57cb3de72dcb9e",
    }),
    Object.freeze({
      path: "packages/subagent/subagent/tests/service.spec.ts",
      blob: "01a17cb591efeafc515b1a7c52cc6808b95ca874",
      sha256: "8544e5d8dd51c2ca006027003c3afc0b0b3fba4f4451b56a846e3451b2c2d242",
    }),
    Object.freeze({
      path: "packages/util/output-retention/src/index.ts",
      blob: "9d90d6b7013331662f79eabab1ca1105e9cf22c1",
      sha256: "fbe1c6ff8c6fc09e62c5b90fb98bcaba2ccddfd4cfe1c8e717a97a085ed405d4",
    }),
    Object.freeze({
      path: "pnpm-lock.yaml",
      blob: "6c7ce04c19349c2d5060f15a11eef5b642da0f50",
      sha256: "80fe05eae33582ae26839afd05f1965f9b0e4be11034ddf9797af6085d5ba9b1",
    }),
    Object.freeze({
      path: "scripts/gen-cordis-catalog.ts",
      blob: "9bcbcda614866e8eeb2f9b7673194072b97e5ae1",
      sha256: "2badd2a36149e4f12a798d3497709637a556bca036c3b68fdd4c1c738f07f21a",
    }),
    Object.freeze({
      path: "scripts/type-equiv.manifest.json",
      blob: "d1a15a97023d174311a35109dd28dc4b65ff9523",
      sha256: "7eaf4a26ef34efe6079e0632587b7f2886689f81b94fc4cf7508399c1a20720b",
    }),
  ]),
});

export const PATCHED_SOURCE_TESTS = Object.freeze([
  "packages/fs/fs-local/tests/product-composition.spec.ts",
  "packages/fs/fs-local/tests/fsio.spec.ts",
  "packages/fs/fs-local/tests/filesystem.spec.ts",
  "packages/core/system-prompt/tests/system-prompt.spec.ts",
  "packages/context/agent-instructions/tests/agent-instructions.spec.ts",
  "packages/llm/llm-deepseek/tests/stream.spec.ts",
  "packages/llm/llm-pi-ai/tests/convert.spec.ts",
  "packages/core/agent-loop/tests/publication-guards.spec.ts",
  "packages/core/agent-loop/tests/cancel.spec.ts",
  "packages/core/agent-loop/tests/pre-assistant-commit.spec.ts",
  "packages/core/scope/tests/invariant.spec.ts",
  "packages/session/session-persistence/tests/storage-contract.spec.ts",
  "packages/session/session-persistence-jsonl/tests/current-event-admission.spec.ts",
  "packages/session/session-persistence-jsonl/tests/lease.spec.ts",
  "packages/subagent/subagent/tests/continuation.spec.ts",
  "packages/subagent/subagent/tests/service.spec.ts",
  "packages/subagent/subagent/tests/activation-setup-registry.spec.ts",
  "packages/subagent/subagent-in-process-driver/tests/subagent-in-process-driver.spec.ts",
  "packages/subagent/subagent-spawn-in-process/tests/subagent-spawn-in-process.spec.ts",
  "packages/subagent/subagent-fork-in-process/tests/subagent-fork-in-process.spec.ts",
  "packages/llm/token-meter/tests/token-meter.spec.ts",
  "packages/compaction/compaction/tests/invariant.spec.ts",
  "packages/compaction/compaction-basic/tests/capacity-safe.spec.ts",
  "packages/compaction/compaction-basic/tests/compaction-basic.spec.ts",
  "packages/compaction/compaction-basic/tests/compaction-loop-repro.spec.ts",
  "packages/compaction/compaction-basic/tests/manual-compaction.spec.ts",
  "packages/compaction/compaction-basic/tests/loader-composition.spec.ts",
] as const);

const WAKE_PATCH = "specs/dsh/patches/0001-agent-wake-pending.patch";
const PRE_ASSISTANT_COMMIT_PATCH = "specs/dsh/patches/0002-pre-assistant-commit.patch";
const PUBLICATION_GUARDS_PATCH = "specs/dsh/patches/0004-publication-guards.patch";
const PRODUCT_CONTINUABLE_LIFECYCLE_PATCH = "specs/dsh/patches/0005-product-owned-continuable-lifecycle.patch";
const CAPACITY_SAFE_COMPACTION_PATCH = "specs/dsh/patches/0007-capacity-safe-compaction.patch";
const LITERAL_PROMPT_CONTRIBUTIONS_PATCH = "specs/dsh/patches/0008-literal-prompt-contributions.patch";
const AGENT_INSTRUCTION_SELECTION_PATCH = "specs/dsh/patches/0009-agent-instruction-selection.patch";
const PI_AI_PROVIDER_CONTENT_PATCH = "specs/dsh/patches/0010-pi-ai-provider-content.patch";
const FILE_TOOL_COMPOSITION_PATCH = "specs/dsh/patches/0011-file-tool-composition.patch";
const LITERAL_RUNTIME_CONTEXT_PATCH = "specs/dsh/patches/0012-literal-runtime-context.patch";
export const DSH_SEAM_PATCHES = Object.freeze([
  WAKE_PATCH,
  PRE_ASSISTANT_COMMIT_PATCH,
  PUBLICATION_GUARDS_PATCH,
  PRODUCT_CONTINUABLE_LIFECYCLE_PATCH,
  CAPACITY_SAFE_COMPACTION_PATCH,
  LITERAL_PROMPT_CONTRIBUTIONS_PATCH,
  AGENT_INSTRUCTION_SELECTION_PATCH,
  PI_AI_PROVIDER_CONTENT_PATCH,
  FILE_TOOL_COMPOSITION_PATCH,
  LITERAL_RUNTIME_CONTEXT_PATCH,
] as const);

export interface DshSeamPatchSnapshot {
  readonly bytes: Buffer;
  readonly order: number;
  readonly path: typeof DSH_SEAM_PATCHES[number];
  readonly sha256: string;
}

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function patchEvidence(path: string, order: number): {
  readonly order: number;
  readonly path: string;
  readonly sha256: string;
} {
  return Object.freeze({
    order,
    path,
    sha256: sha256(readFileSync(resolve(repositoryRoot, path))),
  });
}

export function readDshSeamPatchSet(): readonly DshSeamPatchSnapshot[] {
  return Object.freeze(DSH_SEAM_PATCHES.map((path, index) => {
    const bytes = Buffer.from(readFileSync(resolve(repositoryRoot, path)));
    return Object.freeze({
      bytes,
      order: index + 1,
      path,
      sha256: sha256(bytes),
    });
  }));
}

export function buildDshSeamDecisions(): object {
  const patchEvidenceByPath = new Map<string, ReturnType<typeof patchEvidence>>(
    DSH_SEAM_PATCHES.map((path, index) => [path, patchEvidence(path, index + 1)]),
  );
  const patch = (path: string): ReturnType<typeof patchEvidence> => {
    const evidence = patchEvidenceByPath.get(path);
    if (evidence === undefined) throw new Error(`unregistered DSH seam patch: ${path}`);
    return evidence;
  };

  return {
    schemaVersion: 1,
    recordedAt: "2026-09-30",
    authority: DSH_SEAM_SOURCE,
    productProfileActivation: "forbidden-until-patched-DSH-artifact-and-batch-1-gate",
    candidateIntegration: "0.2.0 RC2 upgrade; exact acceptance requires rebuilt artifact, Runtime composition and Host gates",
    patchSeries: DSH_SEAM_PATCHES.map((path, index) => patchEvidence(path, index + 1)),
    decisions: [
      {
        id: "DSH-SEAM-001",
        upgradeDisposition: "rebase",
        seam: "restart-wake-existing-inbox-message",
        status: "candidate_patch_pending_product_validation",
        adr: "specs/adr/0001-wake-existing-inbox-message.md",
        rejected: "remove-and-reinsert-with-public-Inbox-and-Agent-followup",
        selectedPublicApi: "Agent.wakePending?(messageId: MessageId): boolean; required by official composition",
        patch: patch(WAKE_PATCH),
        executableEvidence: [
          "actual Inbox FIFO reorder under remove/reinsert",
          "no-splice wake preserves MessageId and FIFO",
          "crash after intent/wake/completion converges",
          "patched ReactLoopAgent abort-to-idle latch and FIFO regressions",
          "one pending identity is claimed exactly once",
        ],
        removalCondition: "an installed DSH release exposes an equivalent tested public wake-existing seam",
      },
      {
        id: "DSH-SEAM-002",
        upgradeDisposition: "rebase",
        seam: "authoritative-pre-assistant-tool-input-transform",
        status: "candidate_patch_pending_product_validation",
        adr: "specs/adr/0002-pre-assistant-commit-waterfall.md",
        rejected: "rewrite-only-execution-input-or-proxy-tool-runtime",
        selectedPublicApi: "agent/pre-assistant-commit waterfall over PreparedAssistantCommit",
        patch: patch(PRE_ASSISTANT_COMMIT_PATCH),
        executableEvidence: [
          "model-order multi-call transformation",
          "one value across assistant history, tool/call, permission, UI, execution, result and resume",
          "denial, timeout, crash, invalid value and cancellation append no authoritative identity",
          "extra message, source, block, and prepared-plan keys are rejected before canonical reconstruction",
          "text-only and max-token output bypass; no-listener equivalence and real in-flight listener replacement",
        ],
        removalCondition: "an installed DSH release exposes an equivalent tested authoritative transform",
      },
      {
        id: "DSH-SEAM-003",
        upgradeDisposition: "retire",
        seam: "product-required-session-event-recognition",
        status: "candidate_retirement_pending_product_validation",
        adr: "specs/adr/0003-product-session-event-predicate.md",
        rejected: "mark-required-events-ignorable-or-import-private-known-event-state",
        selectedPublicApi: "public SessionPersistence Provider, SessionHandle, KNOWN_SESSION_EVENT_TYPES and native event admission",
        executableEvidence: [
          "candidate public Provider must accept registered required product events across append/read/cold restore",
          "unknown required events must remain refused through the product Provider",
          "stock validateStoredEvents retains native refusal behavior; product extension never mutates the stock registry",
        ],
        removalCondition: "an installed DSH release exposes an equivalent tested required-event registry",
      },
      {
        id: "DSH-SEAM-004",
        upgradeDisposition: "keep_public_composition",
        seam: "persistence-mutation-and-rewind-composition",
        status: "candidate_public_composition_pending_product_validation",
        adr: "specs/adr/0004-shared-backend-lock-and-immutable-rewind-generation.md",
        rejected: "surface-shadow-rewind-or-private-storage-import",
        selectedPublicApi: "product SessionPersistence/SessionHandle Provider plus mutation companion sharing one per-Session lock",
        executableEvidence: [
          "backend append and mutation commit serialize",
          "retirement and exact revision are commit preconditions",
          "stale revision fails closed after an in-flight append",
          "retirement drains, aborted mutation commits nothing, and preparation cache invalidates",
          "cold rewind generation preserves immutable stable prefix, product fold, and derived history",
          "public SessionHandle Provider plus exact-revision recoverable tombstone delete must survive response loss",
        ],
        removalCondition: "superseding ADR after production SQLite fault evidence proves a narrower composition",
      },
      {
        id: "DSH-SEAM-005",
        upgradeDisposition: "rebase",
        seam: "root-agent-and-session-publication-guards",
        status: "candidate_patch_pending_product_validation",
        adr: "specs/adr/0005-root-publication-guards.md",
        rejected: "post-publication-agent-created-veto-and-registry-snapshot-detection",
        selectedPublicApi: "AgentRegistry.setPublicationGuard and SessionStore.setPublicationGuard",
        patch: patch(PUBLICATION_GUARDS_PATCH),
        executableEvidence: [
          "Session guard rejects before store or attachment mutation",
          "Agent guard rejects before registry mutation with exact runtime-owner input",
          "guard registration is exclusive, effect-scoped, and restores stock behavior on disposal",
          "official one-root permit covers Session and Agent entry plus reentrant publication observation",
          "direct Session and advanced Agent publication bypasses fail before visibility",
        ],
        removalCondition: "an installed DSH release exposes equivalent synchronous pre-publication guards",
      },
      {
        id: "DSH-SEAM-006",
        upgradeDisposition: "rebase",
        seam: "product-owned-continuable-subagent-lifecycle",
        status: "candidate_patch_pending_product_validation",
        adr: "specs/adr/0006-product-owned-continuable-lifecycle.md",
        rejected: "allow-stock-parent-notice-or-interrupt-only-teardown-to-escape-product-work-ownership",
        selectedPublicApi: "stock SubagentRuntime.drainContinuableChildren plus patched registerContinuableSetup, deliverContinuable, withContinuableAncestors, ContinuableStartSpec.settlementDelivery, SubagentRunEndInfo.infrastructureFailure, and resumeContinuable",
        patch: patch(PRODUCT_CONTINUABLE_LIFECYCLE_PATCH),
        executableEvidence: [
          "stock callers retain parent settlement delivery by default",
          "trusted composition setup installs only into unpublished continuable child scopes and revokes with the existing Activation lifecycle",
          "external ownership suppresses the automatic parent notice and lets completed parents release while background descendants continue",
          "composition delivery retains exact source and steer/queue scheduling through live and cold admission",
          "scoped ancestor residency follows exact durable direct-parent edges without synthetic Inbox input, model turns or activation events; parked pending identities remain owned until explicit wake",
          "concurrent ancestry callers share one retained handle and stale parent objects cannot create new children after release",
          "scoped subtree drain follows durable ancestor identities after the original parent Agent was evicted",
          "the delivery owner survives durable descriptor load and cold resume",
          "external ownership makes the existing final child-Session flush strict before handle release",
          "a strict durability failure rejects the upstream selected-child drain and marks the terminal edge without relabeling child model errors",
          "upstream selected-child drain cancels top-down and releases descendant handles child-first",
          "cold recovery wakes one exact already-durable Inbox identity without reinsertion",
          "all reconstructed pending FIFO identities retain Activation ownership until claimed or discarded",
        ],
        removalCondition: "an installed DSH release exposes equivalent durable settlement ownership, strict external final durability, no-reinsert pending wake, and scoped cold-ancestor residency; trusted setup was removed in rc.1 and remains patched; selected-child drain is stock",
      },
      {
        id: "DSH-SEAM-007",
        upgradeDisposition: "retire",
        seam: "deepseek-stream-tool-identity",
        status: "candidate_retirement_pending_product_validation",
        adr: "specs/adr/0007-deepseek-stream-tool-identity.md",
        rejected: "replace-the-official-provider-adapter-or-repair-empty-tool-identities-after-DSH-emission",
        selectedPublicApi: "stock @deepseek-ai/dsh-llm-deepseek adapter with guarded streamed call-id and tool-name updates",
        executableEvidence: [
          "an established V4-Flash tool id and name survive empty continuation fields",
          "every subsequent tool-call delta retains the established identity",
          "the final assembled tool-call block retains the established identity and concatenated arguments",
          "non-empty stock call identity behavior and parallel-call indexing remain unchanged",
        ],
        removalCondition: "an installed DSH release preserves established call ids and tool names across empty stream continuation fields",
      },
      {
        id: "DSH-SEAM-008",
        upgradeDisposition: "rebase",
        seam: "capacity-safe-structured-compaction",
        status: "candidate_patch_pending_product_validation",
        adr: "specs/adr/0008-capacity-safe-compaction.md",
        rejected: "duplicate-private-DSH-range-and-transaction-logic-in-product-code",
        selectedPublicApi: "TokenMeter.estimateRequest plus stock BasicCompactionEngine capacity fitting, structured validation/repair, safe telemetry, and direct-call count provenance",
        patch: patch(CAPACITY_SAFE_COMPACTION_PATCH),
        executableEvidence: [
          "one singleton estimator prices durable pressure and exact summary requests",
          "summary output cap follows the independently resolved summary model",
          "known-overflow summary requests fail before Provider call and durable bracket",
          "the largest fitting tool-balanced older range is selected",
          "Prompt v2 shallow validation permits at most one repair and aggregates usage only when every call reports it, preserving unknown buckets and exact totals",
          "direct stream-call count remains backward compatible for old one-call events",
          "content-free telemetry excludes synthetic secret and checkpoint canaries",
          "stock manual, automatic pressure, and Provider-overflow regressions remain green",
        ],
        removalCondition: "an installed DSH release exposes equivalent tested request estimation and capacity-safe structured compaction semantics",
      },
      {
        id: "DSH-SEAM-009",
        upgradeDisposition: "rebase",
        seam: "literal-prompt-contributions",
        status: "candidate_patch_pending_product_validation",
        adr: "specs/adr/0009-literal-prompt-contributions.md",
        rejected: "reject-or-escape-external-markdown-and-reimplement-prompt-rendering-in-product-code",
        selectedPublicApi: "stock PromptSection.interpolate plus patched SubagentStartRequest.personaInterpolate, persisted for continuable cold resume",
        patch: patch(LITERAL_PROMPT_CONTRIBUTIONS_PATCH),
        executableEvidence: [
          "sections preserve literal brace examples while omitted flags retain strict interpolation",
          "one-shot in-process child personas preserve literal external text",
          "continuable child persona interpolation choice survives descriptor persistence and cold resume",
          "only descriptor version 5 is admitted; versions 3 and 4 fail closed after the approved development reset",
        ],
        removalCondition: "an installed DSH release exposes equivalent durable child-persona semantics; literal section handling is stock in rc.2 and context handling is tracked separately",
      },
      {
        id: "DSH-SEAM-010",
        upgradeDisposition: "rebase",
        seam: "mutually-exclusive-agent-instruction-candidates",
        status: "candidate_patch_pending_product_validation",
        adr: "specs/adr/0010-agent-instruction-selection.md",
        rejected: "a-second-host-crawler-or-watcher-for-primary-workspace-instructions",
        selectedPublicApi: "agent-instructions Config.candidateSelection and Config.fileTouchToolNames",
        patch: patch(AGENT_INSTRUCTION_SELECTION_PATCH),
        executableEvidence: [
          "first selection loads one non-empty candidate per directory and falls through confirmed empty files",
          "unavailable higher-priority candidates never activate a lower-priority protocol",
          "winner replacement emits old removal and new set in one durable context batch",
          "configured canonical Read/Write/Edit results trigger nested reconciliation",
          "omitted options retain stock all-candidates and lowercase tool-name behavior",
        ],
        removalCondition: "an installed DSH release exposes equivalent first-candidate and configurable filesystem-touch semantics",
      },
      {
        id: "DSH-SEAM-011",
        upgradeDisposition: "rebase",
        seam: "pi-ai-provider-owned-content-preservation",
        status: "candidate_patch_pending_product_validation",
        adr: "specs/adr/0011-provider-owned-content-preservation.md",
        rejected: "flatten-provider-blocks-to-markdown-or-manufacture-local-tool-calls",
        selectedPublicApi: "@deepseek-ai/dsh-llm ContentBlockMap augmentation plus stock llm-pi-ai stream/replay adapters",
        patch: patch(PI_AI_PROVIDER_CONTENT_PATCH),
        executableEvidence: [
          "Provider call and result blocks remain ordered structured non-executable content",
          "native replay reconstructs exact Provider raw blocks only for the matching pi-ai route",
          "unknown Provider block types remain generic and do not require tool-name heuristics",
          "canonical local tool calls continue through the unchanged DSH tool execution pipeline",
        ],
        removalCondition: "an installed DSH release preserves generic Provider-owned pi-ai content and exact matching-route replay",
      },
      {
        id: "DSH-SEAM-012",
        upgradeDisposition: "rebase", seam: "official-file-tool-composition",
        status: "candidate_patch_pending_product_validation",
        adr: "specs/adr/0012-official-file-tool-composition.md",
        rejected: "duplicate-file-tool-executors-or-production-use-of-test-only-fsio-internals",
        selectedPublicApi: "tool-fs createReadTool/createReadImageTool/createWriteTool/createEditTool; fs-local prepareTextEdit and protected beforePublish",
        patch: patch(FILE_TOOL_COMPOSITION_PATCH),
        executableEvidence: ["stock tool definitions execute inside the product permission/checkpoint scope", "LF edits preserve stored CRLF bytes and checkpoint hashes", "publication policy runs after staging without taking over atomic I/O"],
        removalCondition: "installed DSH exposes equivalent factories, stored-edit preparation and publication policy hook",
      },
      {
        id: "DSH-SEAM-013",
        upgradeDisposition: "rebase",
        seam: "literal-runtime-context",
        status: "candidate_patch_pending_product_validation",
        adr: "specs/adr/0009-literal-prompt-contributions.md",
        rejected: "escape Host text or duplicate dynamic-context projection in the product",
        selectedPublicApi: "PromptContext.interpolate propagated through assembly and renderContextSections",
        patch: patch(LITERAL_RUNTIME_CONTEXT_PATCH),
        executableEvidence: [
          "Host-owned dynamic context preserves literal braces and unknown template-looking text",
          "ordinary dynamic contexts retain strict variable interpolation",
        ],
        removalCondition: "an installed DSH release exposes literal dynamic context rendering with default interpolation unchanged",
      },
    ],
    evidenceOwners: {
      runtimeSemantics: "tests/dsh-seam-spikes.unit.test.ts",
      patchedSourceTypecheck: "tsc -b tsconfig.host.json",
      patchedSourceTests: PATCHED_SOURCE_TESTS,
    },
  };
}

export function serializeDshSeamDecisions(): string {
  return `${JSON.stringify(buildDshSeamDecisions(), null, 2)}\n`;
}

function git(sourceRoot: string, args: string[], env?: NodeJS.ProcessEnv, input?: Buffer): Buffer {
  return execFileSync("git", ["-c", "core.autocrlf=false", "-C", sourceRoot, ...args], {
    encoding: "buffer",
    env: env ?? process.env,
    input,
    maxBuffer: 16 * 1024 * 1024,
  });
}

// Keep the online store prime and offline seam compile on the same workspace closure.
export const DSH_SEAM_INSTALL_FILTERS = Object.freeze([
  "--filter", "@deepseek-ai/dsh-system-prompt...",
  "--filter", "@deepseek-ai/dsh-agent-instructions...",
  "--filter", "@deepseek-ai/dsh-agent-loop...",
  "--filter", "@deepseek-ai/dsh-session-persistence...",
  "--filter", "@deepseek-ai/dsh-session-persistence-jsonl...",
  "--filter", "@deepseek-ai/dsh-fs-local...",
  "--filter", "@deepseek-ai/dsh-tool-fs...",
  // The subagent closure reaches unrelated document and office packages.
  "--filter", "@deepseek-ai/dsh-subagent",
  "--filter", "@deepseek-ai/dsh-subagent-in-process-driver",
  "--filter", "@deepseek-ai/dsh-subagent-spawn-in-process",
  "--filter", "@deepseek-ai/dsh-subagent-fork-in-process",
  "--filter", "@deepseek-ai/dsh-session-title",
  "--filter", "@deepseek-ai/dsh-tool-todo",
  "--filter", "@deepseek-ai/dsh-session-projection-cache",
  "--filter", "@deepseek-ai/dsh-permission-presets",
  "--filter", "@deepseek-ai/dsh-chunked-list",
  "--filter", "@deepseek-ai/dsh-schedule",
  "--filter", "@deepseek-ai/dsh-llm-deepseek...",
  "--filter", "@deepseek-ai/dsh-llm-deepseek-api-key...",
  "--filter", "@deepseek-ai/dsh-llm-pi-ai...",
  "--filter", "@deepseek-ai/dsh-compaction-basic...",
  "--filter", "@deepseek-ai/dsh-compaction...",
  "--filter", "@deepseek-ai/dsh-token-meter...",
]);

const run = (command: string, args: string[], cwd: string, input?: Buffer): void => {
  const invocation = childCli(command, args);
  execFileSync(invocation.command, [...invocation.args], {
    cwd,
    env: process.env,
    input,
    stdio: input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
  });
};

export function verifyDshSeamSource(
  sourceRoot: string,
  compileAndTest = false,
  patchSet: readonly DshSeamPatchSnapshot[] = readDshSeamPatchSet(),
): void {
  const root = resolve(sourceRoot);
  const commit = git(root, ["rev-parse", `${DSH_SEAM_SOURCE.commit}^{commit}`]).toString("utf8").trim();
  const tree = git(root, ["rev-parse", `${DSH_SEAM_SOURCE.commit}^{tree}`]).toString("utf8").trim();
  if (commit !== DSH_SEAM_SOURCE.commit || tree !== DSH_SEAM_SOURCE.tree) {
    throw new Error("DSH seam source commit/tree differs from the accepted baseline");
  }

  for (const file of DSH_SEAM_SOURCE.files) {
    const blob = git(root, ["rev-parse", `${DSH_SEAM_SOURCE.commit}:${file.path}`]).toString("utf8").trim();
    const bytes = git(root, ["cat-file", "blob", `${DSH_SEAM_SOURCE.commit}:${file.path}`]);
    if (blob !== file.blob || sha256(bytes) !== file.sha256) {
      throw new Error(`DSH seam source drift: ${file.path}`);
    }
  }

  const temporaryRoot = mkdtempSync(join(tmpdir(), "myagents-dsh-seam-index-"));
  const environment = {
    ...process.env,
    GIT_INDEX_FILE: join(temporaryRoot, "index"),
  };
  try {
    git(root, ["read-tree", DSH_SEAM_SOURCE.commit], environment);
    for (const patch of patchSet) {
      git(root, ["apply", "--cached", "--check", "-"], environment, patch.bytes);
      git(root, ["apply", "--cached", "-"], environment, patch.bytes);
    }
    git(root, ["diff", "--cached", "--check"], environment);
  } finally {
    rmSync(temporaryRoot, { recursive: true });
  }

  if (!compileAndTest) return;
  const storeInvocation = childCli("corepack", ["pnpm", "store", "path"]);
  const pnpmStore = execFileSync(storeInvocation.command, storeInvocation.args, {
    cwd: root,
    encoding: "utf8",
    env: process.env,
  }).trim();
  const worktreeParent = mkdtempSync(join(tmpdir(), "myagents-dsh-patched-source-"));
  const worktree = join(worktreeParent, "deepseek-harness");
  try {
    run("git", ["-c", "core.autocrlf=false", "-C", root, "worktree", "add", "--detach", worktree, DSH_SEAM_SOURCE.commit], root);
    for (const patch of patchSet) {
      run("git", ["-c", "core.autocrlf=false", "apply", "-"], worktree, patch.bytes);
    }
    run("git", ["diff", "--check"], worktree);
    run("corepack", [
      "pnpm", "install", "--offline", "--frozen-lockfile", "--ignore-scripts",
      "--reporter=append-only", "--store-dir", pnpmStore, ...DSH_SEAM_INSTALL_FILTERS,
    ], worktree);
    run("corepack", [
      "pnpm", "exec", "tsc", "-b",
      "packages/core/system-prompt/tsconfig.json",
      "packages/context/agent-instructions/tsconfig.json",
      "packages/core/agent/tsconfig.json",
      "packages/core/agent-loop/tsconfig.json",
      "packages/core/session/tsconfig.json",
      "packages/core/scope/tsconfig.json",
      "packages/session/session-persistence/tsconfig.json",
      "packages/session/session-persistence-jsonl/tsconfig.json",
      "packages/fs/fs-local/tsconfig.json",
      "packages/fs/tool-fs/tsconfig.json",
      "packages/subagent/subagent/tsconfig.json",
      "packages/subagent/subagent-in-process-driver/tsconfig.json",
      "packages/subagent/subagent-spawn-in-process/tsconfig.json",
      "packages/subagent/subagent-fork-in-process/tsconfig.json",
      "packages/llm/llm-deepseek/tsconfig.json",
      "packages/llm/llm-pi-ai/tsconfig.json",
      "packages/llm/token-meter/tsconfig.json",
      "packages/compaction/compaction/tsconfig.json",
      "packages/compaction/compaction-basic/tsconfig.json",
      "--pretty", "false",
    ], worktree);
    // Native JSONL write-handle regressions require the host flock addon.
    // The selected Node installation must supply its own development headers.
    run("corepack", ["pnpm", "run", "build:native-system"], worktree);
    run("corepack", [
      "pnpm",
      "exec",
      "vitest",
      "run",
      "--pool=forks",
      "--maxWorkers=1",
      "--fileParallelism=false",
      ...PATCHED_SOURCE_TESTS,
    ], worktree);
  } finally {
    try {
      run("git", ["-C", root, "worktree", "remove", "--force", worktree], root);
    } finally {
      rmSync(worktreeParent, { recursive: true, force: true });
    }
  }
}
