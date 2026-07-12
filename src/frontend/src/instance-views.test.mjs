import assert from "node:assert/strict";
import test from "node:test";

import { groupInstances, instanceRowPresentation } from "./instance-groups.ts";

const instance = (overrides) => ({
  selector: "alpha@deploy-a",
  name: "Alpha",
  ownerDeployId: "deploy-a",
  status: "running",
  kind: 1,
  platform: "",
  ownerUserId: "",
  ...overrides,
});

test("groups LightOS instances, remote devices, and SSH profiles in stable order", () => {
  const groups = groupInstances([
    instance({ selector: "ssh:prod", name: "Production", kind: 3 }),
    instance({ selector: "client:client-a", name: "Alice PC", kind: "INSTANCE_KIND_REMOTE_CLIENT", platform: "darwin" }),
    instance({ selector: "alpha@deploy-a", name: "Alpha", kind: "INSTANCE_KIND_LIGHTOS" }),
  ]);

  assert.deepEqual(groups.map((group) => group.id), ["lightos", "remote", "ssh"]);
  assert.deepEqual(groups.map((group) => group.instances[0].name), ["Alpha", "Alice PC", "Production"]);
});

test("presents remote platform metadata and keeps offline devices disabled", () => {
  const presentation = instanceRowPresentation(instance({
    selector: "client:client-a",
    name: "Alice PC",
    status: "offline",
    kind: 2,
    platform: "darwin",
  }));

  assert.deepEqual(presentation, {
    kind: "remote",
    metadata: "darwin",
    running: false,
  });
});
