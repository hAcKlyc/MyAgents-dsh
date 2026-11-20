import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { childCli } from "./child-cli.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

export const DSH_SEAM_SOURCE = Object.freeze({
  repository: "https://github.com/deepseek-ai/deepseek-harness.git",
  commit: "9c2670d3bce5275e0d1610272958121af87787bb",
  tree: "6ec0fcdcaf38bdf8ffa6675e30b036dc104a1ece",
  declaredRelease: "0.2.2-rc.5",
  executablePackageAssociation: "unproven",
  files: Object.freeze([
    Object.freeze({"path": "packages/subagent/subagent/tests/sibling-messages.spec.ts", "blob": "04a3a6b02483618c0d8626da3201245d3460b9ef", "sha256": "d1b2e4afd5ab366470d998f84033de5fa14405208c028aaf94328bcc432fb375"}),
    Object.freeze({"path": "packages/subagent/tool-subagent-control/tests/tool-subagent-control.spec.ts", "blob": "5ea4866a1cd6224f82c1e42d08d49bad761fb999", "sha256": "b50eaebe2b83a57144fc639ec693504fed687135f25f204e60c9e23adfa2b376"}),
    Object.freeze({"path": "packages/core/agent-loop/tests/scope-lifecycle.spec.ts", "blob": "4b01c61f80ec786eed4d92685986c1b751259023", "sha256": "8d5c8aa30d321fb1686a20de872002fc5f66dfc3fb58e833a1120dbe9c292e80"}),
    Object.freeze({"path": "packages/core/agent-loop/src/index.ts", "blob": "bda53c3b56788393d9d0c433690a4404fd0e766f", "sha256": "2a00160a00d818b420dd0c0b7af2d50ba9fd4bdcf66c50d2126eaaf8cfe7d301"}),
    Object.freeze({"path": "packages/llm/llm-pi-ai/src/prefix-binding.ts", "blob": "9ca530c33932cb4f02e3a0f4096db979eaf76f4e", "sha256": "9ab70fc968a65f902154b6a2dd31453e2277d0c57722316c817050009a85883e"}),
    Object.freeze({"path": ".agents/notes/implemented/architecture/2026-08-31-explicit-agent-runtime-identity.i18n.yaml", "blob": "f8de1ed3b14d5e436f23cb305cbb3175cc44c87e", "sha256": "641472095dd79c2e23f83ef8b9b6772e749792a9dc0c7ec87357c519459cac57"}),
    Object.freeze({"path": ".agents/notes/implemented/architecture/2026-08-31-explicit-agent-runtime-identity.md", "blob": "336151fa837b85235f814dd36a15faa6bcf7a38c", "sha256": "7cb570cd2abceece53c655816056d3770bb81577473225917a7ad13ddd933c86"}),
    Object.freeze({"path": ".agents/notes/implemented/architecture/2026-08-31-explicit-agent-runtime-identity.zh.md", "blob": "063f0490bb6e16051c8ba9c4b72261545fb7afee", "sha256": "07c0d77d4ed8cccc6a12072a7743af0e946bee8302978602a8f17efa9362a65f"}),
    Object.freeze({"path": "docs/architecture.i18n.yaml", "blob": "d89722980629bc6b597e63fe6b4fb99d601f2ffe", "sha256": "48b789123e77ae9ed27c6a757064ff133ef2b2709bef7badacd703798da2a655"}),
    Object.freeze({"path": "docs/architecture.md", "blob": "c7c036016b16c68d0beab5ec7af14c55a5f584e3", "sha256": "6a075f9477ef2c5265568b986ea5edfefcf581da4050f7ccf32e3247875ea942"}),
    Object.freeze({"path": "docs/architecture.zh.md", "blob": "2eae1137696639cc473afefbdf255c44eee32939", "sha256": "8c1b6693c1c044bf9ca9cbdc1865cabbc37450a44956c7ad6050179e7b106dfc"}),
    Object.freeze({"path": "docs/config-catalog.i18n.yaml", "blob": "355b83b670d3fde0de94eac995ffba8636225888", "sha256": "40f148c047c3700525caa5aaa4979969bbc79be6418a08c8a965d7e7d5596b2e"}),
    Object.freeze({"path": "docs/config-catalog.md", "blob": "da7c10b10b284a36fe34a804fc7ca81d1fedeefa", "sha256": "f139d221c7d353ed616c775d4b7b5d25cc93a38ddcd591b9cea630a253cee655"}),
    Object.freeze({"path": "docs/config-catalog.zh.md", "blob": "c526b1a821da6599db33bda042547dacd846b569", "sha256": "c6da8cd304e0d38df2e133997847f09be64e76c12ee3479a1afc9c304c81788a"}),
    Object.freeze({"path": "docs/event-producer-consumer.i18n.yaml", "blob": "9defd245a747bfc166dde886012a48e85420031e", "sha256": "bd98773412f43cf9af653e54cbfb15f6feb9482229a19a5e99976a8980acb98a"}),
    Object.freeze({"path": "docs/event-producer-consumer.md", "blob": "1d80e1cfe70738aa31ca86822870d8232fa1e6a1", "sha256": "6618110f56a7fdf39227f61df9f413a9117d981f8cdbea82821ddff6cd061ece"}),
    Object.freeze({"path": "docs/event-producer-consumer.zh.md", "blob": "9245fa8fab69fce96da5369d5b0b77571fb8ea68", "sha256": "cf01a2f71298ced7619e0e24e81f4e955bc07d18ff2cf21e26945be501ecb8c4"}),
    Object.freeze({"path": "docs/persistence-catalog.i18n.yaml", "blob": "f2294edff673eaef771f558e24cea9772399e4f6", "sha256": "d486cb89488580035e0bbf211925f265c8a0eac7ce7880b5f31045ba644a185e"}),
    Object.freeze({"path": "docs/persistence-catalog.md", "blob": "33d9aa43956360d507661d003f05f30e11940e0e", "sha256": "a12777e24575022879bcf0516dcad36c07d05d99eba2958732431399ff0973f3"}),
    Object.freeze({"path": "docs/persistence-catalog.zh.md", "blob": "5047ebc659d4d0bc7dd882686fc80cccfc521bb5", "sha256": "c83e6d9eccb794735790d1f8addb83ddabb2dc2f9285fc11b0bdc20e421d3778"}),
    Object.freeze({"path": "docs/subsystems/compaction.i18n.yaml", "blob": "fb62fa8a42b2164bdd12a2049f43c45c593e835f", "sha256": "0c5e86c7e2edc45777dd6a012c86d6d4d2ddf7963108fb58d6a3c47079bf5803"}),
    Object.freeze({"path": "docs/subsystems/compaction.md", "blob": "415c3b06bee6675fee5daf330aadfdd2ab3d6f98", "sha256": "eeda604d2e3da90ada52ef143cf7807f2f9969174379e5e2182442f763cf16e8"}),
    Object.freeze({"path": "docs/subsystems/compaction.zh.md", "blob": "94b9256e055f4ec87dd5446cbe4487b3a9acd18e", "sha256": "df932a45d03deeaa6159c91c9bb3cd8aa8ba0d94a55abd73f54b9a3b3e859f0c"}),
    Object.freeze({"path": "docs/subsystems/core.i18n.yaml", "blob": "363584a5fdc4be9ee17b1360a9b46d4e276ea6df", "sha256": "b6056835c73a35e805207add3fb71934cb7b51bcf14fd04608832a24436546cc"}),
    Object.freeze({"path": "docs/subsystems/core.md", "blob": "a00dc512efd50be69b12813b40a19e7081a8dd82", "sha256": "6d13ab30d5a86e560cadfdf488dfbb302be90676680b205b49d5497c197375f1"}),
    Object.freeze({"path": "docs/subsystems/core.zh.md", "blob": "5cb66a1692b34f1132724632c87e9e36c017226e", "sha256": "de4fa16d1d3f5ab022a0924ecc59447a0d8d0136b892c8621a10dc7a605ec4da"}),
    Object.freeze({"path": "docs/subsystems/session-projection.md", "blob": "01dbdd99e2439a787f66be46c9ea4f6045f4de1b", "sha256": "ade9f3697b6441e224671bdf0b324c1698adb9959c26942d0cfcbf9ad286817c"}),
    Object.freeze({"path": "docs/subsystems/session-projection.zh.md", "blob": "675d49b5751788db3fae264bda26561bdf005223", "sha256": "9e96dc20c8c015fcbc7eee2f3e81d86904b785b43245ad3bebf58c7bb66acebd"}),
    Object.freeze({"path": "docs/subsystems/session.i18n.yaml", "blob": "2c56dc6e7643a58cfe1bf27eae33e4b0a354c0e6", "sha256": "a9796bc54799da54fefd4b6ebd4644d895ce09fd41f2b82c5c02ba362a1c9f28"}),
    Object.freeze({"path": "docs/subsystems/session.md", "blob": "c1651bf32e7b0cd18b23d4bd137ccf5c965b7247", "sha256": "0a0e266aef757da0ed525cd62084b73fe8ea44c41753a2fcb93a03b5fccaa9c3"}),
    Object.freeze({"path": "docs/subsystems/session.zh.md", "blob": "e359382e86bee8da64ef1e751f903d0608a2113b", "sha256": "8cbd5a690bec2536a4df03b40ee57d409d9f583aa669df153ffb995d40c45268"}),
    Object.freeze({"path": "docs/subsystems/subagent.i18n.yaml", "blob": "8a6bd71c02cbfcff308dabd25a2a0f5a12ba881b", "sha256": "fffa94ab0d82eeee21940bc0cec997e5e9816436875e55c7aaa76255ad841656"}),
    Object.freeze({"path": "docs/subsystems/subagent.md", "blob": "488ef66ac46a06b7e947f7990e0a9c5a978fdef7", "sha256": "7cd8dc50f5097a83d7ea175da9edbda30c9f52f8efe911da38cebbae20e088b4"}),
    Object.freeze({"path": "docs/subsystems/subagent.zh.md", "blob": "8f1d6b74a2aa03c3e9a72715eb2bc755a8ee6091", "sha256": "8b13700aa125fe0329d04206349b83725e9444a8534617742f66e4f0838030bd"}),
    Object.freeze({"path": "docs/subsystems/system-prompt.i18n.yaml", "blob": "707a80dd3ab2966dce0b2543a3ddb14fd2edf5d8", "sha256": "9a270fc7beb024938f115925aa9bf22b08d7812f5cb1063f6dc85f8d91e6d9b2"}),
    Object.freeze({"path": "docs/subsystems/system-prompt.md", "blob": "b29547379a1555560f43214d75d4208fd5630176", "sha256": "ed1b131fabaa03fca622b4ca7e649f035f0f1c37b480486f813d074b1ef667d9"}),
    Object.freeze({"path": "docs/subsystems/system-prompt.zh.md", "blob": "83c6d7564b1ec7bda40c81a0b91de08c351ecac1", "sha256": "aea673bc82014e368f7febe7a304d4ec30d985dac8a839ac25b1ec09b81d47d0"}),
    Object.freeze({"path": "docs/subsystems/token-meter.i18n.yaml", "blob": "f205395403695629138aef31a996caabf42e6e6b", "sha256": "e09838aa34c60eacd18236c54eac61e2b15b82cac0a583a9a564a791a1efe885"}),
    Object.freeze({"path": "docs/subsystems/token-meter.md", "blob": "1aa56a8d2412ee44f1c2cd30123ec0693d54bc7d", "sha256": "d284e102ddc834fe25acc45d613cdbdb6c11ec59ce9d9fca951e5a4c843c5490"}),
    Object.freeze({"path": "docs/subsystems/token-meter.zh.md", "blob": "970f90d9ddd74780fe6301cb7b01af4a1b5b0800", "sha256": "584a45c2d90f7ccc6496aa2ddb4abb6f628d3e501e1f450709b91f8cd022c6ba"}),
    Object.freeze({"path": "package.json", "blob": "d5c9d2c44985d4b5eb7cf76ee533c57a4e90cd7b", "sha256": "1d36929c6e7613f31ba4c108483683d49b65f0c399a5c1dadb0ad08af68ccc42"}),
    Object.freeze({"path": "packages/compaction/compaction-basic/README.i18n.yaml", "blob": "e2609ea23a0a5cfaa6e1fabf37b73a2fd505efe2", "sha256": "f11bb67cd95f905c933161c3a5a8453e6a04422a349b7e4572d3e7297c5788ae"}),
    Object.freeze({"path": "packages/compaction/compaction-basic/README.md", "blob": "c8d0c6b748ee1789607776473c9f5a6d1a1fc829", "sha256": "c89320abc365da40a4779af0811b24cd27e527ec93251cddbcc2fb38ccdef0d7"}),
    Object.freeze({"path": "packages/compaction/compaction-basic/README.zh.md", "blob": "023d9ea43695b636643dd8ab8d301685a9b283c4", "sha256": "554cab425867d45b6f9cf87421181d3b9e23c3976b66677a79ba89a3fea89f9a"}),
    Object.freeze({"path": "packages/compaction/compaction-basic/src/index.ts", "blob": "096fa72fe46a1a715a3a34a2a109b4dc379de42b", "sha256": "1d2ecc563147967f86842b37289682a4dd7feabccc9d9d8d55cfb01810166f54"}),
    Object.freeze({"path": "packages/compaction/compaction-basic/src/region.ts", "blob": "7b3d77d299881fa47b8dfdab7fae0a92cd7d462c", "sha256": "295b53cc9e924f7cb2e843e0d0d296e89ead73da2aab9790282db30736e2e063"}),
    Object.freeze({"path": "packages/compaction/compaction-basic/src/summarizer.ts", "blob": "6220a53b255abda122be6aca711991c3a1654401", "sha256": "4f16b70148ffc9042e51bba2b0a8f3b35da55fcaba28d0c8cbf36102c9eecc99"}),
    Object.freeze({"path": "packages/compaction/compaction-basic/src/types.ts", "blob": "23e195aab788d2e020f149f9e7df1b2ac70bea57", "sha256": "65fc3147b4b5a6d7ef422131374aa9f7a6e246d56feabca37755b9ca432ab57d"}),
    Object.freeze({"path": "packages/compaction/compaction-basic/tests/compaction-basic.spec.ts", "blob": "cf6780933d9fca175aa7330552d9461e3b72461d", "sha256": "48c4ddaf4405c825762b5115e70ab64486a6fe8812bde1a5adce9ea4b0aac117"}),
    Object.freeze({"path": "packages/compaction/compaction-basic/tests/compaction-loop-repro.spec.ts", "blob": "2777a6e29bff8188ef9858d4079a4b57880eb43a", "sha256": "acdd65ae57c712c4b7aeff044b9d243794c4133d84b270de657278aa007ec30a"}),
    Object.freeze({"path": "packages/compaction/compaction-basic/tests/runtime-context-admission.spec.ts", "blob": "2c3bdbb95fcbb4fb266001141c5055d5f107c878", "sha256": "c6473ce6d0f7c7c25db1f290b90a017ff26684ed479a93b5bd28a3a4530bea16"}),
    Object.freeze({"path": "packages/compaction/compaction/README.i18n.yaml", "blob": "0b16898c61f797e46e8dce8374a288afaab444fe", "sha256": "82661557f7ee27c9c28d96977856061e31803950c691c3d2f68ac7a1eb7cd2b3"}),
    Object.freeze({"path": "packages/compaction/compaction/README.md", "blob": "b8de223d36db65742f6a0e81476aa3b6f172113b", "sha256": "e6188b799ebad2ff8f07c076e475dbc7f2747b3c06c7febeb825d439b93bec3e"}),
    Object.freeze({"path": "packages/compaction/compaction/README.zh.md", "blob": "092688ccf27367be7356b620df6bab744cc8ec79", "sha256": "89b3745b1f2079ec06ce9e2052b4604c002796f867f164921b5c53f2d3d65df4"}),
    Object.freeze({"path": "packages/compaction/compaction/src/types.ts", "blob": "0c69c53debbbe51135c745006d7d90f9db183081", "sha256": "af47584231f20be810e5d1f354f5f23d1a02995c454b4d2027070b502eae1e22"}),
    Object.freeze({"path": "packages/context/agent-instructions/README.i18n.yaml", "blob": "4e32e2bec593d80df21316ade4776b6ab7457cf7", "sha256": "5b0b9a3b137482f65a12e36185075d150a2e82de29fb522d8eba7fb5fa566dde"}),
    Object.freeze({"path": "packages/context/agent-instructions/README.md", "blob": "49a66930d69cc8b67492d00e320d2f3d3aa17d90", "sha256": "e084b89a94b63d4e4deb455feb5ca7f101326086409d3aa4513e445b18b8ae9a"}),
    Object.freeze({"path": "packages/context/agent-instructions/README.zh.md", "blob": "b584ccac1fe2e9bd5a53b92345ec9844122ec6ba", "sha256": "eb768a8af1d5de4d9d0a767441f98d0bd3611f3e7ac4df6a93f374b46352f739"}),
    Object.freeze({"path": "packages/context/agent-instructions/src/config.ts", "blob": "5ae3c3454c7f42dedf229467aed5d2df0da1b93e", "sha256": "e19acb898825a7324434b1b69021ee16e79030277e9f791c325287f2073c8644"}),
    Object.freeze({"path": "packages/context/agent-instructions/src/files.ts", "blob": "de3650d05cd462a32eca22ccd2397a6f387668e0", "sha256": "79d64704d1d86ba9d6a11d91e1a596d84de6d774e80c3bbf275f24f6b4ca1f5c"}),
    Object.freeze({"path": "packages/context/agent-instructions/src/index.ts", "blob": "ec752e07150ff3da38e7d7264cee825f7d3f881b", "sha256": "2cca75eef331d2ba2e615a6d7292037ad189121bbe53f773e5888149b24975b6"}),
    Object.freeze({"path": "packages/context/agent-instructions/src/state.ts", "blob": "9727d7acf482d9488ac1bf4ddc26147518e62f76", "sha256": "9f1dd768d9a0e24defe2fce728111a7a898a12a69c2a64b23c0882f561438f38"}),
    Object.freeze({"path": "packages/context/agent-instructions/tests/agent-instructions.spec.ts", "blob": "5393fda5d1f3d85f88799b100bd06b8206c04fb5", "sha256": "4607efeabfae01876904f3090ba5b3fb9e410fa6c94a35de0a3f06da8f569b92"}),
    Object.freeze({"path": "packages/context/time-context/src/index.ts", "blob": "160beb9e8a46b9a09206d8ee52fa463a951877e9", "sha256": "b8779494ef88cfe5cf4e529c07c92084c16711e48e38c72af1ad2dee9881bd82"}),
    Object.freeze({"path": "packages/context/time-context/tests/time-context.spec.ts", "blob": "ba07a2f1f63150bf01eb453e748fae6434f8d8b5", "sha256": "f8165685807593542f1328e2da3f83a5296b828b3bc9b0f4d2a95db4cc28a1ac"}),
    Object.freeze({"path": "packages/core/agent-loop/README.i18n.yaml", "blob": "253c4536e469afb50f49c6f50276a69cabad91e5", "sha256": "c710c4128c934b094bc148808b071c22bab785360ae4e6f6afeaa2b1193f45fe"}),
    Object.freeze({"path": "packages/core/agent-loop/README.md", "blob": "30443d6acee22bc0109be67295055d14acc9d047", "sha256": "3f18ec7b6655de35b73ecf4505bfc8828c4d759e1d653e413f115c9b8e9b0258"}),
    Object.freeze({"path": "packages/core/agent-loop/README.zh.md", "blob": "e20aa96f37df7679ab2b40f1a735a754de5c45af", "sha256": "3b95d2bd7424f3d9dfa58fc9a32b4c10a791c5a0c4d58d63b913a01f2b80e3d8"}),
    Object.freeze({"path": "packages/core/agent-loop/src/agent.ts", "blob": "7ec43dd1323edc6e2b488d7c9d35fdd2d323abbd", "sha256": "6fa6bd4c0ab2aaea988b92a3fd079fa38271f4b8065ec325a6ab09ec93eb13c8"}),
    Object.freeze({"path": "packages/core/agent-loop/tests/cancel.spec.ts", "blob": "e5e9be01fc4bf0d619bb693eec688a49ebd5f438", "sha256": "37669c115d22cea4f71f4b2f8993e7dacb3a826a1047772a0a7f818afcec93fa"}),
    Object.freeze({"path": "packages/core/agent/README.i18n.yaml", "blob": "46e9eb2a5a6c6f5e9c2a3174f40ea8bab5bec7b9", "sha256": "f7905f35cfc38df7d732a336b2c7dd4145c0dd9ba80fc4cf5f54b2ba3762472b"}),
    Object.freeze({"path": "packages/core/agent/README.md", "blob": "c7ff87b6d0aad7b047f9a82d83d2b9a609dc7f2b", "sha256": "b19682f29e2e3c8159a128dea7e1b35b70f3dd8fe5beaeed117f63b9cbe286fe"}),
    Object.freeze({"path": "packages/core/agent/README.zh.md", "blob": "98cda698193ad6e01005fcb9a8af6a38d029ce31", "sha256": "f0ed351a36f921c7c990cc2afa92e247cf8fc11e863d46265b2f60a5976acdba"}),
    Object.freeze({"path": "packages/core/agent/package.json", "blob": "836b81fa0e2a6e6447aa10ddedc48b8681bc5b9a", "sha256": "306b2d0fca657f2690e02647b228c1a7b29ca437b1228614dc0295fa54fc2b6f"}),
    Object.freeze({"path": "packages/core/agent/src/index.ts", "blob": "374be301803f7100b3c349ddd857178817d6eb68", "sha256": "c3af768658850fddda9ec91afb12f55a52b6101c43356b428919679a525e2bba"}),
    Object.freeze({"path": "packages/core/agent/src/runtime-types.ts", "blob": "7012dfdf50b7c78b07697fbe0cdc9defec7bb957", "sha256": "2efd41d7b0e1c52d3b1cada23c4af63d9f6cd58f62812bdc9147bbfb282e3203"}),
    Object.freeze({"path": "packages/core/scope/README.i18n.yaml", "blob": "f5011125b1edc3183e7209e356acc58791fa2fb7", "sha256": "7d4492b76760378adf6b0c6e609ceca12a8ff6a074588c3c045cd33dd27b88fd"}),
    Object.freeze({"path": "packages/core/scope/README.md", "blob": "d5f88240e07cfbf113e9b554b2814ab916529795", "sha256": "a78f5ea99004e168a32e096b06d45c661736828c414123eba7f6104b55d64280"}),
    Object.freeze({"path": "packages/core/scope/README.zh.md", "blob": "a5cf67dcf51e72d1e49fbabddf3d8646e466bda1", "sha256": "78012222db4f96c7b5b7446964d31745d5dcd32ab844c9af3a832cb8db9a0288"}),
    Object.freeze({"path": "packages/core/session/README.i18n.yaml", "blob": "0d793887f420da74b4fed61c6be69c588d5f674c", "sha256": "e41ab2a8530ffced02ccc527991d9fae157a7b56c5cc079b6f02d653527b8ed9"}),
    Object.freeze({"path": "packages/core/session/README.md", "blob": "3b55b1fcced8dd7625e17d034e87b515f69af4d5", "sha256": "3dc8af1ff43e4615e1f3db42418e9406ed0be5e6abddba19368773562e9f7332"}),
    Object.freeze({"path": "packages/core/session/README.zh.md", "blob": "9ca25d8a115657276af567c6ca6d4c4e50d56289", "sha256": "073f01d3a413bce095675ba2241b8dd47924b3ab36e4b884af4bb32a01210b52"}),
    Object.freeze({"path": "packages/core/session/src/index.ts", "blob": "ea6c337f553c0a5bd0836a47301d59cc16bafa26", "sha256": "8941b4c7a45debf2443b0f937830f806130167e3ef53426833f7225dd5a8bb8f"}),
    Object.freeze({"path": "packages/core/session/src/known-event-types.ts", "blob": "466e76bb80845580ae24b2e72cc1bafbea88fc2b", "sha256": "6583955525dd8b6869be2c476821f66c837519b7001ba134ab2fb2ecb57ecba9"}),
    Object.freeze({"path": "packages/core/session/src/tool-history.ts", "blob": "90c28dab06aedda41dbe60cc93481551ca3dc392", "sha256": "53ae6aebe5ebe9b1eb782f008315db33ff637611093e40fa3529ec3019b56683"}),
    Object.freeze({"path": "packages/core/system-prompt/README.i18n.yaml", "blob": "293a721008442bac8bbc4955961263802937995f", "sha256": "e335477180364439b5c45bece5886b780bc5ebf230529342b76d279f2bebd469"}),
    Object.freeze({"path": "packages/core/system-prompt/README.md", "blob": "48b43666ee0180ea5b96bec80c915aaa429e97bc", "sha256": "b3e7284f742b2e20f55512cf8ac890a2867cb94c9ebadc6eed8dba30d7c99330"}),
    Object.freeze({"path": "packages/core/system-prompt/README.zh.md", "blob": "3964b4af1704d7ed1ac552bac252923848380fc4", "sha256": "654e44cd9ca721af209de3fee531147a4d93c68a6cf9cc198f9dd5b3049194fd"}),
    Object.freeze({"path": "packages/core/system-prompt/src/index.ts", "blob": "66d0e53a39a8f8bf8329c89629db571a8e65cd83", "sha256": "5e4c530c4096cf30f99cda64d0011661b3a14ed357999b413239984c565bcc4a"}),
    Object.freeze({"path": "packages/core/system-prompt/tests/system-prompt.spec.ts", "blob": "ab27791466f12693957a3c76a8e217276aafaa41", "sha256": "726b479d1fd2184fddcccbc276ffe2ea616c9da79d30d7fc208e2df50b80169a"}),
    Object.freeze({"path": "packages/extensions/tool-cordis/src/api-catalog.ts", "blob": "919025faa0af37f937c92d34d345dfc443eae296", "sha256": "ccb944166821cda40f8f3be36c7845378e0ca9fb83d11a4eed61f7620d6ccc2e"}),
    Object.freeze({"path": "packages/fs/fs-local/README.i18n.yaml", "blob": "4c9e8ec1ef0d2a8e473602051d22860543be6510", "sha256": "3d91d320bb5d3e7338d0c92320367f76cab9f211537eae75ab3399b8183508ca"}),
    Object.freeze({"path": "packages/fs/fs-local/README.md", "blob": "f2846682d7029bb4928c8f6df8fd6b620a3a975a", "sha256": "c713656e5007857b282cdd4ec0022a2db520da004e462ecbf3c0196526be2c65"}),
    Object.freeze({"path": "packages/fs/fs-local/README.zh.md", "blob": "d1abde684192ab76f0a067f0a88f44db4fb45f27", "sha256": "53a401d62722b463b59dbb4586f8e62aba0d1dce21cb5b689e3043a4c78ec5b4"}),
    Object.freeze({"path": "packages/fs/fs-local/src/fsio.ts", "blob": "c6959128a48fd83b5fe87a1817482d08f895aff0", "sha256": "c8eb0a79a08a8586cebc37b6b633721cc764fee806566c7beaeb20979ae8e66c"}),
    Object.freeze({"path": "packages/fs/fs-local/src/index.ts", "blob": "e9ee2b8395a85c802205867558c5bcd6e45f81d8", "sha256": "e43441b0ad597efe3a8f4f111d4de1322ca38c8b62ec9842a813361cb79de334"}),
    Object.freeze({"path": "packages/fs/tool-fs/README.i18n.yaml", "blob": "f9d9c8ac828e56561e17eda4bc74099bcf07f117", "sha256": "74b9ad0d7426930cc28338f1ab043e6ae901d242387d698079cfa73bfd069a3a"}),
    Object.freeze({"path": "packages/fs/tool-fs/README.md", "blob": "93985eeb21557c6aae3c5738d5ca3bcddcc98050", "sha256": "189cf12e7d6488b95b99486eaaf3c8a4a89141c6d8d444a52a59c60a41834136"}),
    Object.freeze({"path": "packages/fs/tool-fs/README.zh.md", "blob": "ec28bf145c2049e60c1fa24514179861fb42e734", "sha256": "25294b669f11d66fce285444c12c755e7efc73b3143eb348df134d417ec87320"}),
    Object.freeze({"path": "packages/fs/tool-fs/src/edit.ts", "blob": "8de03306ca83fa1d3c2ab97f06839a47a4e7d274", "sha256": "d6e20da949509e3fafd96b048c0abb6f6e3a74cdeb749a712eaa78dd9c0f5d8b"}),
    Object.freeze({"path": "packages/fs/tool-fs/src/index.ts", "blob": "41e3be251cf9e55ad5b4bc1a81f0717a795fe04f", "sha256": "a25592c2541fbc609b2b4576d365e58e9fc881e959d19bca9c1be16e78f0c469"}),
    Object.freeze({"path": "packages/fs/tool-fs/src/read-image.ts", "blob": "be422b38aa3d849a4c299a10b3b1ac43f4cb0f1c", "sha256": "0cc7b00b1a85df559b6f297cbb4e16ce13cbb15c09c3ad1f9d28d105a7f10e6a"}),
    Object.freeze({"path": "packages/fs/tool-fs/src/read.ts", "blob": "fcd42c3e071db237b89bbfe94e7cca3aed4d4f2a", "sha256": "e92f53e67a689ef99e5976adb2dc2f2bf5de31d064f1be69a70cf55005687bf3"}),
    Object.freeze({"path": "packages/fs/tool-fs/src/sandbox.ts", "blob": "08b776fd927208ba0873cc0b8189fff781703c50", "sha256": "65cf0602689dfcb5e005960475bc3bf26512bb0c8ff8c4f200b76ac4717d9b35"}),
    Object.freeze({"path": "packages/fs/tool-fs/src/write.ts", "blob": "37d1263d208f2e1daf18da9f274ce164b9308c24", "sha256": "d9dd36495151b831a54fce735166f3303cbd93b507fdded5626063c8c112d508"}),
    Object.freeze({"path": "packages/interaction/user-approval/src/types.ts", "blob": "12b8106d3460c80f952a754b4420c6dcbfb217c2", "sha256": "4413da55040e100e5700b5b89dccf387e08275587ac21876cba8cbab2df34037"}),
    Object.freeze({"path": "packages/llm/llm-deepseek-api-key/package.json", "blob": "0919d9044172290edfa61ec61df19a70cd76a495", "sha256": "7c82d202017ae08c8ce99920b686c9fdcb897d44280ca5c9c52394f15cb1cdeb"}),
    Object.freeze({"path": "packages/llm/llm-deepseek-api-key/src/config.ts", "blob": "a05b6c2f5ad4e33ee7e1509b8a1b4db3bacf37b9", "sha256": "f4c15f5bfbdd61dffde76538d8b6fd4bd154112290fc2ce059ab4a7838a6d287"}),
    Object.freeze({"path": "packages/llm/llm-deepseek-api-key/src/index.ts", "blob": "ac0f4753c57babed438543afae85b3a4a97554aa", "sha256": "c77d06339ff80604091693ac53cb18796d4f796a8e752e4c26ea5f5d4925ecea"}),
    Object.freeze({"path": "packages/llm/llm-deepseek/src/host.ts", "blob": "c9e89cad8e31303901ed945c4a92c1666d29d847", "sha256": "bc050e0676915deeb083f61a8a06eaf37ffda7d18e078417905689b98df4626d"}),
    Object.freeze({"path": "packages/llm/llm-deepseek/src/translate.ts", "blob": "b92f5f3c212e734bf808e360a83a2865f5a5b432", "sha256": "7550ba8f5ba2262c47671e56eca60220aec1480bf65b91911500825dd084f3fb"}),
    Object.freeze({"path": "packages/llm/llm-deepseek/tests/stream.spec.ts", "blob": "187e978d1343e92e44040adca01e20d95a25b4b3", "sha256": "e7354d41b2578b303382933ee2f45b05a746e84cc9fa56041a79621e4e68000b"}),
    Object.freeze({"path": "packages/llm/llm-pi-ai/README.i18n.yaml", "blob": "fd6a360e8b0203c4872b581344ed55aaa36b8664", "sha256": "c61048ce0aad1ab275fae9b682c741eab76dc8e88e4e29bd803d4f98721b3d9d"}),
    Object.freeze({"path": "packages/llm/llm-pi-ai/README.md", "blob": "2bba84d774c401f2ed8c25527861125f72d33a8d", "sha256": "731e12e382233aaf4a444536cc2f66a3657816ed21ba5a9dd2c8eeb780d9ab9d"}),
    Object.freeze({"path": "packages/llm/llm-pi-ai/README.zh.md", "blob": "9a964b8681143336d89f5401bd867fcaaf3e5378", "sha256": "4f2788d798e4335d263276b629a81e8f6703474d68382867c06f1da079e56d52"}),
    Object.freeze({"path": "packages/llm/llm-pi-ai/src/adapter.ts", "blob": "f3f9ac0090a0feb8aeb68f18540e5198e5aca711", "sha256": "70f877e8c4fa4243038c3e793379e1aa0717d9d8dcf59363b56eed2d248511f8"}),
    Object.freeze({"path": "packages/llm/llm-pi-ai/src/catalog.ts", "blob": "b2103095743bae6408d2359d3a886f749f63a950", "sha256": "2acfd765ca51ee4feb8a28ab56fc740bf329d4bf53c7fc66885a3243bff799b6"}),
    Object.freeze({"path": "packages/llm/llm-pi-ai/src/config.ts", "blob": "9de6c4416eb61d2a95139c4530488148266ed29a", "sha256": "7f28b27ad8833639c1506bee00d4917f68cdae6b1277c17d5135164a205c3af9"}),
    Object.freeze({"path": "packages/llm/llm-pi-ai/src/index.ts", "blob": "a671b7229ae72a64a660668adaccc3d32e53947c", "sha256": "5fed9aaa84810ade2975faaf756661361e5fd45d302705a14cff8520169bb258"}),
    Object.freeze({"path": "packages/llm/llm-pi-ai/src/models.ts", "blob": "bde2148f1bdcbc7ecc56881fe140be4479a1fc42", "sha256": "5371f5f8e82cc7c70943bb09e0aba1d261df2a76408e45d56651705382b908b9"}),
    Object.freeze({"path": "packages/llm/llm-pi-ai/src/replay.ts", "blob": "ba1be42e142c13135279caf90a7f1d1950caab6f", "sha256": "d181b1f4cb2725dcc5b83436e3b66a959d28002a076b26d68d02865d1b3f9cbf"}),
    Object.freeze({"path": "packages/llm/llm-pi-ai/src/stream.ts", "blob": "c3bfc1cd3f0068cdc6a74ca0f424b7dbed030a04", "sha256": "a835a110ad769a2208e42224cbbd6d6239adb39508718f011ea0ad602bf035c5"}),
    Object.freeze({"path": "packages/llm/llm-pi-ai/tests/catalog.spec.ts", "blob": "32bb8f39933cd905163eea6e8870575656e0b5d8", "sha256": "3fddccbe3747a98a826fd2da1cc72c584fe54cd61d6f9770ed35c350a073537d"}),
    Object.freeze({"path": "packages/llm/llm-pi-ai/tests/convert.spec.ts", "blob": "ff5a65870b9f672a19befe4d655067729479902b", "sha256": "7da4f9970a7bab1ab45ce1475c6e7165725ce5ee0def79a0b4c9aba70eae0557"}),
    Object.freeze({"path": "packages/llm/llm/src/content.ts", "blob": "b86238111819ae2f4541a6ddf3578602cbb0ae12", "sha256": "60fff14a31f8230b4a1c26772f7a1986617b1f037b19c2c0ee1986163bc81701"}),
    Object.freeze({"path": "packages/llm/token-meter/README.i18n.yaml", "blob": "739fefb1486638328965369e2621dd20f22f35d7", "sha256": "14553c5b253a8f641208e478946de7b94da9a9e494639cefc73be1eb70f369ab"}),
    Object.freeze({"path": "packages/llm/token-meter/README.md", "blob": "e128f57e43689520ff3ae59424716806a8395315", "sha256": "3ca36704b9c1e22645eefa66169f4c09dfd2e87fb8529ee8edd6fa55f71547ad"}),
    Object.freeze({"path": "packages/llm/token-meter/README.zh.md", "blob": "a209e04ee3e27260930870788450aa049077d008", "sha256": "dbce2245fc42e9f19a792f191fb611522a7361b1c1bf40eab705ae4631be190f"}),
    Object.freeze({"path": "packages/llm/token-meter/src/estimate.ts", "blob": "ca54abf6b225a251dad09d61cbcbc90dea57dcd2", "sha256": "30ecc576a77aa3a65fb8173c551e13d7651ddba2d7bbd907845a003f17ee189d"}),
    Object.freeze({"path": "packages/llm/token-meter/src/index.ts", "blob": "8b4f7fff94f477906fa59288374282efabbac994", "sha256": "9c9fd53d119cd80b6c03a0db1a7ac45197d2c384df3cf39ce9584584302b49bc"}),
    Object.freeze({"path": "packages/llm/token-meter/src/surface-fold.ts", "blob": "22235ba03217f4271a76dd03dd94c5258e34dee1", "sha256": "686f597a7fdc9d45394c68eb8ef4f472094978d2483b597ee2a1def210dfb878"}),
    Object.freeze({"path": "packages/llm/token-meter/src/types.ts", "blob": "487e031385da91e4f900ce3bf471f7bac791e6b5", "sha256": "d0c153b4ff135839c072b1c57056366003028fb2f5ba7ea745845580c5fcb08f"}),
    Object.freeze({"path": "packages/llm/token-meter/tests/route-pricing.spec.ts", "blob": "08959f288e528673c9e578a2b0606bfc53be39e6", "sha256": "ee3e911882635c226810b8b8afc821a2bb69fa46f92c4f4c14d799c2f016fab3"}),
    Object.freeze({"path": "packages/session/session-persistence-jsonl/README.md", "blob": "2de63df367a24722812b7cd494a2fb0b6ba5d8cc", "sha256": "85392cc2c4655582e2d29b7e848d08bf8681bd0cc36c6a30eacfba963821581e"}),
    Object.freeze({"path": "packages/session/session-persistence-jsonl/src/index.ts", "blob": "f8351fa9ee75db9790859de9672d1602c0c05664", "sha256": "1475457333ca86a01f7ea72dcf33de25b02be8b9c670fb32e8b99d8efb54cd81"}),
    Object.freeze({"path": "packages/session/session-persistence-jsonl/tests/current-event-admission.spec.ts", "blob": "ac57369d55734ba512e9548e427bd6c85b237761", "sha256": "2e2072d0f0db8cacf60e07b199d2608c4f2e3e3c5f1cc0d6ae3f2d24801840b8"}),
    Object.freeze({"path": "packages/session/session-persistence-jsonl/tests/lease.spec.ts", "blob": "f05f87e6f4625c4683adcbd19c913f169bf126d8", "sha256": "24a86ae7ef908f5fe813a125fcd70617bec8aeceec50c10b4ec5e6759f74dfc2"}),
    Object.freeze({"path": "packages/session/session-persistence-jsonl/tests/teardown-loader.e2e.ts", "blob": "b06980f01490064196006d20e53e224fe69c2915", "sha256": "63f14a0776f6dc06abf19c375c5227e437868cda239d0c533a35806e01307132"}),
    Object.freeze({"path": "packages/session/session-persistence/src/handle.ts", "blob": "b6a194c87d14b787df55452e50f0008b3f56337a", "sha256": "2fd8b5c5188ffdf5adee78a260b3dd0a9be97e5eb9fcdb5aafae5a8ed5471a31"}),
    Object.freeze({"path": "packages/session/session-persistence/src/index.ts", "blob": "951c60b31f2254d7950a3c3a450e4c0ffbc5efcc", "sha256": "15d2feeaa8876d4be1c87234ac92e50d819c500444588e497d5228aed1876fc7"}),
    Object.freeze({"path": "packages/session/session-persistence/src/storage-contract.ts", "blob": "172a59a25829235d117ef767296a8e244f721ce3", "sha256": "062911ece08832418f2fd0dc8fabdd8848897de6b2d97bc7fca54a634e0c99bd"}),
    Object.freeze({"path": "packages/session/session-persistence/tests/storage-contract.spec.ts", "blob": "2f34cd384f60217e4b4c5be44a03bc882445a0bb", "sha256": "09726bddef0e2b31fe104a719e44c88a9dc8584147ce81de8647f4a1c20a1f55"}),
    Object.freeze({"path": "packages/session/session-projection/src/index.ts", "blob": "b4aa95d5df2f1953a903dd37143be02bf06a65c7", "sha256": "8799ce0906032333a8840debae461bab1129167f5ee073acd33b6167247ae64b"}),
    Object.freeze({"path": "packages/session/session-projection/src/types.ts", "blob": "1a558a43b59b6c77caea5de3d944f3315a7b5b8e", "sha256": "2e82335afac870475220034c9fcf546a9ac1f97b791b1bccfb8aa356d3763120"}),
    Object.freeze({"path": "packages/session/session-projection/tests/registration-reader.spec.ts", "blob": "8c10b46a94bf1a642177246938638ab58d9d4dda", "sha256": "83b97aaedc6352c8660c79b62e0b0efe4871a7fdad30562ab72767e093e3f1c9"}),
    Object.freeze({"path": "packages/session/session-projection/tests/registry.spec.ts", "blob": "a1f8c7897f6fcd8b7f323212e414e487db6a7b0e", "sha256": "5b210d8a7834f1bc16fc39ca5c1a6ea785c005ea0add4d6b7139d724f8334108"}),
    Object.freeze({"path": "packages/session/working-directory/package.json", "blob": "179f521132d76b795eea7c0333d01b37dcf6acd5", "sha256": "ee68b6aea5ed9395797d259215b6ca3983e139bc4f28c90bd34abbb0bd57c0a5"}),
    Object.freeze({"path": "packages/session/working-directory/src/index.ts", "blob": "6ef5ce027947a3f0dc5e989ab88afdbd483da5cc", "sha256": "fedc2ed302dc5d2e2f8082b457b978ff3ea5089078da5f0477c892abef4def76"}),
    Object.freeze({"path": "packages/subagent/subagent-fork-in-process/src/index.ts", "blob": "38181395527282793911f99bff4f7d02d3e69c25", "sha256": "1bc4ff5ff22c20937b6224ffe208a3c37b18c2b741ed77330c27432ce23cf30e"}),
    Object.freeze({"path": "packages/subagent/subagent-fork-in-process/tests/subagent-fork-in-process.spec.ts", "blob": "601444e5d0bd810b9aa3880e0f7cbe3a8aac75ed", "sha256": "156f81246620ff80f4d092a75e17746d7702067805a65b340bdbbf19d3e88517"}),
    Object.freeze({"path": "packages/subagent/subagent-spawn-in-process/README.i18n.yaml", "blob": "cd2ac2ed304c02916c92f8cdbd0356e3014a8e0c", "sha256": "f9a92f47f259ee71ae512cbf41487457b40024b127a24bfbbdc5753d41af158b"}),
    Object.freeze({"path": "packages/subagent/subagent-spawn-in-process/README.md", "blob": "c81fb639017d54f3fe9b6ad76a5e403b40b2b2b2", "sha256": "3722bfc92b121600dd95c268525e7d7f51b115856b3992c09ace58d56ca27dba"}),
    Object.freeze({"path": "packages/subagent/subagent-spawn-in-process/README.zh.md", "blob": "b60b16cab280775b7c56b6889600914d3fa2d92d", "sha256": "aaa18e53ede54c2f4b55dd19c5d194c7813aab108b7ed183a870cd0bbb225325"}),
    Object.freeze({"path": "packages/subagent/subagent-spawn-in-process/src/index.ts", "blob": "41f429ee7bc6ea6741ad9a6f4f317df57b84f874", "sha256": "6bb457b871c8a8a3c638affff51665cba08eaf4f3c9e9738d6137d951b8c4ec0"}),
    Object.freeze({"path": "packages/subagent/subagent-spawn-in-process/tests/subagent-spawn-in-process.spec.ts", "blob": "c254b67c8c1acbad498bff5c3e2f92f4b98d2b99", "sha256": "4381191ffde769f1dac4bf53957ef31cc1782d7582d056418e8ddb4ae780115b"}),
    Object.freeze({"path": "packages/subagent/subagent/README.i18n.yaml", "blob": "d6864b8745bd1882b2aa3bdb9fef5e3339935e66", "sha256": "9377e60e7e2bf4509f1ec240254b1c5be342e6b12ad9cdbddcab9db93ce9cfbe"}),
    Object.freeze({"path": "packages/subagent/subagent/README.md", "blob": "a212a1ff724c5b70ff3dfb62b25e9047b50988ab", "sha256": "6fa80138bc4fb7f767b7d9130de73f24dee07a01ecd9b1c34d01e8e34d30472d"}),
    Object.freeze({"path": "packages/subagent/subagent/README.zh.md", "blob": "a1f2745150beccb5510142ee7175f26e1f1dddac", "sha256": "bb24b7ae8fd513f0859f501e0b9fc73693f7c6daea40a6381774e425084c6c62"}),
    Object.freeze({"path": "packages/subagent/subagent/src/child-agent.ts", "blob": "98ebfc9d5d03f680b853d33dd1bd85ecd1157a56", "sha256": "f632ef9e600a0508a4112e47f7862a3382ae5080d03353d04ed2449eda6f4fac"}),
    Object.freeze({"path": "packages/subagent/subagent/src/descriptor.ts", "blob": "cc2158daaf0913ee5babb98a3504e2a9c0a8facf", "sha256": "9b080ad713b781e0b00abc7470ad245a37af57afb1ee52b96b662c5e41b2e6bb"}),
    Object.freeze({"path": "packages/subagent/subagent/src/index.ts", "blob": "bb89264e918a64cdca6719500010e9dad28fc014", "sha256": "b9b098db20176ea066895bda65aa20aadfb8d32f25a5a2eb033122885a74bf36"}),
    Object.freeze({"path": "packages/subagent/subagent/src/lifecycle.ts", "blob": "f86eba552f351b57e49b9c2e1d3788cbf75eb765", "sha256": "2f7ce6138d1f048b919303c525483052d45007184846a305790cd8ac07b0cd8c"}),
    Object.freeze({"path": "packages/subagent/subagent/src/list-children.ts", "blob": "41e0b88915b67500550b5683f9078300c6f9cc69", "sha256": "8badec227a2461a1e3f567e32272bc2cce98cb7829d1359f4560c599ee73c513"}),
    Object.freeze({"path": "packages/subagent/subagent/src/manager.ts", "blob": "59639cef703a70930aef7b900569aea1389343a5", "sha256": "8488f36b734c946fdc577c6542205ab7c68f82df413e607427108060393532a5"}),
    Object.freeze({"path": "packages/subagent/subagent/src/projection.ts", "blob": "3fe2eacc285b41e96e744a8a0dadd33e06f63cc2", "sha256": "8e3f7b28b5b427659fd06583134878009c50a6bcab0c1a6adbf7068215ff44c8"}),
    Object.freeze({"path": "packages/subagent/subagent/src/types.ts", "blob": "1786ed8e2ebb3b0195b972628468b8867ea614f1", "sha256": "a1c296b8efba4b4004263d37703d98457a17b2f1f78cf600effa794e7db9b8cc"}),
    Object.freeze({"path": "packages/subagent/subagent/tests/activation-policy.spec.ts", "blob": "e061c840c34e77d86abc21248899388fabb65fa5", "sha256": "f2dfa2a5c72124411741d511a652672ea04e585af36cd89b4fd27d73cceb534d"}),
    Object.freeze({"path": "packages/subagent/subagent/tests/continuation.spec.ts", "blob": "5e32c776bf19aaa8af2fcb80a1d2f3d7dd45a982", "sha256": "86b4f088dafc8ad626cfa294732a0afa66ccfeef08b3d61070cb98826e4e5856"}),
    Object.freeze({"path": "packages/subagent/subagent/tests/service.spec.ts", "blob": "df60318b647349efb3ed1a8eecdb3c26cb126cb1", "sha256": "ceaf4e1e60933524500e6006d9b0fb745978d3d78939e323d5c2a7efbabb5f0a"}),
    Object.freeze({"path": "packages/util/output-retention/src/index.ts", "blob": "9d90d6b7013331662f79eabab1ca1105e9cf22c1", "sha256": "fbe1c6ff8c6fc09e62c5b90fb98bcaba2ccddfd4cfe1c8e717a97a085ed405d4"}),
    Object.freeze({"path": "packages/web/tool-web/src/search.ts", "blob": "f0bf05242112ef60846c5797ae928670537db7dc", "sha256": "2c38e01cf05cd3e1525a9bc929e150430f6d377203cb21bde5de1c8baddd402c"}),
    Object.freeze({"path": "packages/web/tool-web/tests/tool-web.spec.ts", "blob": "9b9866fbe3f135afdee3e1314ab7f08a6bee7a21", "sha256": "23fe4a37c02d108f5165fa9e05047d9967d89f97be7ffc9fd2a666156774ca31"}),
    Object.freeze({"path": "patches/@earendil-works__pi-ai@1.3.0.patch", "blob": "111e09dceeda04eeb09b034e551a9c495ecff495", "sha256": "4e1c90fd00aea42989664504668633033c1962e53c07860901edb4f72d843765"}),
    Object.freeze({"path": "pnpm-lock.yaml", "blob": "9a84d64b213cb37f074294d8f62c69eb789a8c9a", "sha256": "c24a38565023f08480f3832a554a676ad7479d36c0868063c85ad66ba6d3e68a"}),
    Object.freeze({"path": "scripts/gen-cordis-catalog.ts", "blob": "92ae05967ed355dad01a9e35e1e4fb836011b475", "sha256": "70d41508283812157500c7033d920dc4128b660762e99fd56d93ffd9d71de7b2"}),
    Object.freeze({"path": "scripts/type-equiv.manifest.json", "blob": "05d5355dcc6163c812adface75883e814cff7f17", "sha256": "c2005a443efee5fd25b6463188acc3f111ac8e499a860b50b60f57a8293dbe54"}),
  ]),
});

export const PATCHED_SOURCE_TESTS = Object.freeze([
  "packages/web/tool-web/tests/tool-web.spec.ts",
  "packages/llm/llm-pi-ai/tests/catalog.spec.ts",
  "packages/llm/llm-pi-ai/tests/model-conversation-config.spec.ts",
  "packages/session/session-projection/tests/registration-reader.spec.ts",
  "packages/session/session-projection/tests/registry.spec.ts",
  "packages/context/time-context/tests/time-context.spec.ts",
  "packages/context/time-context/tests/request-zone.spec.ts",
  "packages/context/time-context/tests/time-context.e2e.ts",
  "packages/fs/fs-local/tests/product-composition.spec.ts",
  "packages/fs/fs-local/tests/fsio.spec.ts",
  "packages/fs/fs-local/tests/filesystem.spec.ts",
  "packages/core/system-prompt/tests/system-prompt.spec.ts",
  "packages/context/agent-instructions/tests/agent-instructions.spec.ts",
  "packages/llm/llm-deepseek/tests/stream.spec.ts",
  "packages/llm/llm-pi-ai/tests/convert.spec.ts",
  "packages/core/agent-loop/tests/publication-guards.spec.ts",
  "packages/core/agent-loop/tests/scope-lifecycle.spec.ts",
  "packages/core/agent-loop/tests/cancel.spec.ts",
  "packages/core/agent-loop/tests/pre-assistant-commit.spec.ts",
  "packages/session/session-persistence/tests/storage-contract.spec.ts",
  "packages/session/session-persistence-jsonl/tests/current-event-admission.spec.ts",
  "packages/session/session-persistence-jsonl/tests/lease.spec.ts",
  "packages/subagent/subagent/tests/service.spec.ts",
  "packages/subagent/subagent/tests/sibling-messages.spec.ts",
  "packages/subagent/tool-subagent-control/tests/tool-subagent-control.spec.ts",
  "packages/subagent/subagent-spawn-in-process/tests/subagent-spawn-in-process.spec.ts",
  "packages/subagent/subagent-fork-in-process/tests/subagent-fork-in-process.spec.ts",
  "packages/llm/token-meter/tests/token-meter.spec.ts",
  "packages/compaction/compaction-basic/tests/capacity-safe.spec.ts",
  "packages/compaction/compaction-basic/tests/compaction-basic.spec.ts",
  "packages/compaction/compaction-basic/tests/compaction-loop-repro.spec.ts",
  "packages/compaction/compaction-basic/tests/manual-compaction.spec.ts",
  "packages/compaction/compaction-basic/tests/loader-composition.spec.ts",
  "packages/session/session-persistence-jsonl/tests/extension-event-admission.spec.ts",
  "packages/session/session-persistence-jsonl/tests/jsonl.spec.ts",
  "packages/llm/llm-pi-ai/tests/tool-argument-streaming.spec.ts",
  "packages/subagent/subagent/tests/legacy-descriptor.spec.ts",
  "packages/subagent/subagent/tests/continuation.spec.ts",
  "packages/subagent/subagent/tests/continuation-inheritance.spec.ts",
  "packages/subagent/subagent/tests/continuation-messages.spec.ts",
  "packages/subagent/subagent/tests/parked-wait.spec.ts",
  "packages/subagent/subagent/tests/parent-result.spec.ts",
  "packages/subagent/subagent/tests/activation-policy.spec.ts",
  "packages/subagent/subagent/tests/control.spec.ts",
  "packages/session/working-directory/tests/working-directory.spec.ts",

] as const);

const WAKE_PATCH = "specs/dsh/patches/0001-agent-wake-pending.patch";
const PRE_ASSISTANT_COMMIT_PATCH = "specs/dsh/patches/0002-pre-assistant-commit.patch";
const JSONL_EVENT_VALIDATION_PATCH = "specs/dsh/patches/0003-jsonl-product-event-validation.patch";
const PUBLICATION_GUARDS_PATCH = "specs/dsh/patches/0004-publication-guards.patch";
const PRODUCT_CONTINUABLE_LIFECYCLE_PATCH = "specs/dsh/patches/0005-product-owned-continuable-lifecycle.patch";
const CAPACITY_SAFE_COMPACTION_PATCH = "specs/dsh/patches/0007-capacity-safe-compaction.patch";
const LITERAL_PROMPT_CONTRIBUTIONS_PATCH = "specs/dsh/patches/0008-literal-prompt-contributions.patch";
const AGENT_INSTRUCTION_SELECTION_PATCH = "specs/dsh/patches/0009-agent-instruction-selection.patch";
const PI_AI_PROVIDER_CONTENT_PATCH = "specs/dsh/patches/0010-pi-ai-provider-content.patch";
const FILE_TOOL_COMPOSITION_PATCH = "specs/dsh/patches/0011-file-tool-composition.patch";
const HOST_NEUTRAL_TIME_PATCH = "specs/dsh/patches/0013-host-neutral-time-context.patch";
const MODEL_CONVERSATION_UPDATES_PATCH = "specs/dsh/patches/0015-model-update-capabilities.patch";
const WEB_SEARCH_PARTIAL_RESULTS_PATCH = "specs/dsh/patches/0016-web-search-partial-results.patch";
const HOST_TASK_NOTIFICATION_PATCH = "specs/dsh/patches/0017-host-subagent-task-notification.patch";
export const DSH_SEAM_PATCHES = Object.freeze([
  WAKE_PATCH,
  PRE_ASSISTANT_COMMIT_PATCH,
  JSONL_EVENT_VALIDATION_PATCH,
  PUBLICATION_GUARDS_PATCH,
  PRODUCT_CONTINUABLE_LIFECYCLE_PATCH,
  CAPACITY_SAFE_COMPACTION_PATCH,
  LITERAL_PROMPT_CONTRIBUTIONS_PATCH,
  AGENT_INSTRUCTION_SELECTION_PATCH,
  PI_AI_PROVIDER_CONTENT_PATCH,
  FILE_TOOL_COMPOSITION_PATCH,
  HOST_NEUTRAL_TIME_PATCH,
  MODEL_CONVERSATION_UPDATES_PATCH,
  WEB_SEARCH_PARTIAL_RESULTS_PATCH,
  HOST_TASK_NOTIFICATION_PATCH,
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
    recordedAt: "2026-11-21",
    authority: DSH_SEAM_SOURCE,
    productProfileActivation: "forbidden-until-patched-DSH-artifact-and-batch-1-gate",
    candidateIntegration: "0.2.2 RC5 upgrade; exact acceptance requires rebuilt artifact, Runtime composition and Host gates",
    patchSeries: DSH_SEAM_PATCHES.map((path, index) => patchEvidence(path, index + 1)),
    decisions: [
      {
        id: "DSH-SEAM-018", upgradeDisposition: "rebase", seam: "direct-child-host-task-notification",
        status: "candidate_patch_pending_product_validation",
        adr: "specs/adr/0017-direct-child-host-task-notification.md",
        rejected: "label a Host assignment as human input or an Agent message, or depend on the private manager",
        selectedPublicApi: "SubagentRuntime.queueHostPrompt passes the Host source and queue mode to the native deliverPrompt method; the Product task owner selects the assignment recipient",
        patch: patch(HOST_TASK_NOTIFICATION_PATCH),
        executableEvidence: ["native Host attribution and queue placement", "direct child only across restore and cancellation"],
        removalCondition: "an official process-local public API preserves trusted Host attribution and queued delivery",
      },
      {
        id: "DSH-SEAM-017", upgradeDisposition: "rebase", seam: "native-web-search-partial-results",
        status: "candidate_patch_pending_product_validation",
        adr: "specs/adr/0016-web-search-partial-results.md",
        rejected: "replace native search execution, convert rejected queries into successful empty results, or recover private aggregator state in Product middleware",
        selectedPublicApi: "native applyWebSearchTool aggregation and existing WebSearchResult content/sources presentation",
        patch: patch(WEB_SEARCH_PARTIAL_RESULTS_PATCH),
        executableEvidence: ["a rejected query retains slower completed siblings and reports its failure", "all rejected queries remain failed; completed zero-hit queries remain successful", "caller cancellation drains every request and prevents partial publication", "native source caps, round-robin deduplication and replay metadata remain unchanged"],
        removalCondition: "official native WebSearch aggregation retains completed queries, reports partial and all-failed causes, and preserves drained cancellation without an alternate tool pipeline",
      },
      {
        id: "DSH-SEAM-016", upgradeDisposition: "rebase", seam: "model-declared-conversation-update-capabilities",
        status: "candidate_patch_pending_product_validation",
        adr: "specs/adr/0015-model-update-capabilities.md",
        rejected: "Provider-brand inference, route-wide flags or overriding modelInfo without the matching wire behavior",
        selectedPublicApi: "llm-pi-ai model-only compat declarations feeding native model metadata and pi-ai wire encoding",
        patch: patch(MODEL_CONVERSATION_UPDATES_PATCH),
        executableEvidence: ["strict model config through catalog, modelInfo and loopback wire requests", "undeclared and false remain conservative; route-level and wrong-family declarations rejected", "same-route models keep independent capabilities"],
        removalCondition: "official model-only configuration admits exact protocol capabilities into both native modelInfo and wire encoding with conservative defaults",
      },
      {
        id: "DSH-SEAM-015", upgradeDisposition: "retire", seam: "state-bound-session-projection-registration",
        status: "candidate_retirement_pending_product_validation",
        adr: "specs/adr/0014-session-projection-public-registration-types.md",
        rejected: "skipLibCheck or importing private projection-state augmentation into public consumers",
        selectedPublicApi: "SessionProjections.register returns an awaited handle scoped to its registered state type",
        executableEvidence: ["strict public compilation with client-only, host-only and complete map augmentation", "asynchronous registration and disposal retain the typed session reader"],
        removalCondition: "official public registration declarations pass strict compilation for client-only, host-only and complete augmentation without private state imports",
      },
      {
        id: "DSH-SEAM-014", upgradeDisposition: "rebase", seam: "host-neutral-time-context",
        status: "candidate_patch_pending_product_validation",
        adr: "specs/adr/0013-host-neutral-time-context.md",
        rejected: "post-process native snapshot text or replace the time/projection owner",
        selectedPublicApi: "native TimeContext; omit unavailable browser policy for non-browser input",
        patch: patch(HOST_NEUTRAL_TIME_PATCH),
        executableEvidence: ["non-browser time and elapsed without browser clarification", "old missing-zone readings restore", "resolved and mixed browser policies remain enforced"],
        removalCondition: "installed native TimeContext omits inapplicable browser policy while accepting historical readings",
      },
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
        upgradeDisposition: "rebase",
        seam: "product-required-session-event-recognition",
        status: "candidate_patch_pending_product_validation",
        adr: "specs/adr/0003-product-session-event-predicate.md",
        rejected: "mark-required-events-ignorable-or-reimplement-native-JSONL",
        selectedPublicApi: "official JSONL withStoredEventValidation(validator) plugin factory; native tracker, lifecycle and native validation remain official",
        patch: patch(JSONL_EVENT_VALIDATION_PATCH),
        executableEvidence: [
          "official JSONL cold restore validates every declared required Product payload",
          "unknown required and malformed known Product events remain refused",
          "stock native validation and immutable known-event registry remain unchanged",
        ],
        removalCondition: "official JSONL exposes an equivalent tested trusted extension validation hook",
      },
      {
        id: "DSH-SEAM-004",
        upgradeDisposition: "keep_public_composition",
        seam: "persistence-mutation-and-rewind-composition",
        status: "candidate_public_composition_pending_product_validation",
        adr: "specs/adr/0004-shared-backend-lock-and-immutable-rewind-generation.md",
        rejected: "surface-shadow-rewind-or-private-storage-import",
        selectedPublicApi: "official JSONL SessionPersistence/SessionHandle with product locator leases and mutation/checkpoint coordination",
        executableEvidence: [
          "backend append and mutation commit serialize",
          "retirement and exact revision are commit preconditions",
          "stale revision fails closed after an in-flight append",
          "retirement drains, aborted mutation commits nothing, and preparation cache invalidates",
          "cold rewind generation preserves immutable stable prefix, product fold, and derived history",
          "public SessionHandle Provider plus exact-revision recoverable tombstone delete must survive response loss",
        ],
        removalCondition: "official public mutation APIs cover exact product generation, checkpoint and journal semantics",
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
        upgradeDisposition: "reduce",
        seam: "product-owned-continuable-subagent-lifecycle",
        status: "candidate_patch_pending_product_validation",
        adr: "specs/adr/0006-product-owned-continuable-lifecycle.md",
        rejected: "resurrect removed ProductWork lifecycle or reinterpret historical external ownership as native parent delivery",
        selectedPublicApi: "native startActivation, waitForTreeWork, drainDescendants and prompt; patched version 5 read compatibility and policy-neutral delegation context",
        patch: patch(PRODUCT_CONTINUABLE_LIFECYCLE_PATCH),
        executableEvidence: [
          "new children write native version 3; released version 5 preserves lineage and parent settlement on cold restore",
          "historical external settlement remains readable and explicitly refuses continuation",
          "delegation context defers to effective approval policy: native never rejects without consulting answerers, Host ask accepts an actual approved child operation",
          "old version 5-only reader refuses new version 3 instead of claiming downgrade support",
          "operation terminal waits outside its serialization lock for native children and stable parent sequence",
          "abort, disposal, wait failure and child notification reentrancy retain one operation owner"
        ],
        removalCondition: "official descriptor admission preserves released version 5 history and its settlement authority, and delegation context does not contradict effective approval policy; active scheduling and child lifecycle are already stock",
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
        upgradeDisposition: "reduce",
        seam: "literal-prompt-contributions",
        status: "candidate_patch_pending_product_validation",
        adr: "specs/adr/0009-literal-prompt-contributions.md",
        rejected: "reject-or-escape-external-markdown-and-reimplement-prompt-rendering-in-product-code",
        selectedPublicApi: "stock PromptSection/PromptContext literal contributions; legacy descriptor personaInterpolate on native child restore",
        patch: patch(LITERAL_PROMPT_CONTRIBUTIONS_PATCH),
        executableEvidence: [
          "native version 3 is the only new-write format",
          "released version 5 personaInterpolate false survives cold native restoration",
          "default historical interpolation remains strict; no new-start persona policy is introduced"
        ],
        removalCondition: "official cold child restoration preserves the released literal-persona descriptor field",
      },
      {
        id: "DSH-SEAM-010",
        upgradeDisposition: "rebase",
        seam: "mutually-exclusive-agent-instruction-candidates",
        status: "candidate_patch_pending_product_validation",
        adr: "specs/adr/0010-agent-instruction-selection.md",
        rejected: "a-second-host-crawler-or-watcher-for-primary-workspace-instructions",
        selectedPublicApi: "agent-instructions Config.candidateSelection, Config.fileTouchToolNames and Config.globalInstructionRoots",
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
        upgradeDisposition: "retire",
        seam: "literal-runtime-context",
        status: "candidate_retirement_pending_product_validation",
        adr: "specs/adr/0009-literal-prompt-contributions.md",
        rejected: "escape Host text or duplicate dynamic-context projection in the product",
        selectedPublicApi: "PromptContext.interpolate propagated through assembly and renderContextSections",
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
  "--filter", "@deepseek-ai/dsh-time-context...",
  "--filter", "@deepseek-ai/dsh-agent-loop...",
  "--filter", "@deepseek-ai/dsh-session-persistence...",
  "--filter", "@deepseek-ai/dsh-session-persistence-jsonl...",
  "--filter", "@deepseek-ai/dsh-fs-local...",
  "--filter", "@deepseek-ai/dsh-tool-fs...",
  "--filter", "@deepseek-ai/dsh-tool-web...",
  "--filter", "@deepseek-ai/dsh-working-directory...",
  // The subagent closure reaches unrelated document and office packages.
  "--filter", "@deepseek-ai/dsh-subagent",
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
    // Match the artifact builder: the exact source/lock is verified above.
    // Fresh offline runners cannot re-query registry supply-chain metadata.
    run("corepack", [
      "pnpm", "install", "--offline", "--frozen-lockfile", "--trust-lockfile", "--ignore-scripts",
      "--reporter=append-only", "--store-dir", pnpmStore, ...DSH_SEAM_INSTALL_FILTERS,
    ], worktree);
    run("corepack", [
      "pnpm", "exec", "tsc", "-b",
      "packages/core/system-prompt/tsconfig.json",
      "packages/context/agent-instructions/tsconfig.json",
      "packages/context/time-context/tsconfig.json",
      "packages/core/agent/tsconfig.json",
      "packages/core/agent-loop/tsconfig.json",
      "packages/core/session/tsconfig.json",
      "packages/core/scope/tsconfig.json",
      "packages/session/session-persistence/tsconfig.json",
      "packages/session/session-persistence-jsonl/tsconfig.json",
      "packages/fs/fs-local/tsconfig.json",
      "packages/fs/tool-fs/tsconfig.json",
      "packages/web/tool-web/tsconfig.json",
      "packages/session/working-directory/tsconfig.json",
      "packages/subagent/subagent/tsconfig.json",
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
