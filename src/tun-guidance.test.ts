import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tunPrivilegeGuidance } from "./tun-guidance.js";

describe("tunPrivilegeGuidance", () => {
  it("gives the complete Windows recovery flow after activation rolls back", () => {
    const message = tunPrivilegeGuidance("activation-rolled-back", {
      platform: "win32",
      root: "C:\\Users\\Asterin\\Sash",
    });

    assert.match(message, /sash start.*Then enable TUN again in the dashboard/);
    assert.match(message, /PowerShell as Administrator/);
    assert.match(message, /run "sash service install"/);
    assert.match(message, /If SASH_HOME was explicitly customized/);
    assert.doesNotMatch(message, /\$env:SASH_HOME/);
    assert.doesNotMatch(message, /sash stop/);
  });

  it("points at service installation when the Windows runtime is inactive", () => {
    const message = tunPrivilegeGuidance("runtime-inactive", {
      platform: "win32",
      root: "C:\\Sash",
    });

    assert.match(message, /PowerShell as Administrator/);
    assert.match(message, /run "sash service install"/);
    assert.doesNotMatch(message, /dashboard/);
  });

  it("keeps non-Windows guidance platform-neutral", () => {
    const message = tunPrivilegeGuidance("runtime-inactive", {
      platform: "linux",
      root: "/home/user's/Sash Data",
    });

    assert.match(message, /root privileges/);
    assert.ok(
      message.includes(
        "sudo env SASH_HOME='/home/user'\\''s/Sash Data' \"$(command -v sash)\" restart",
      ),
    );
    assert.doesNotMatch(message, /PowerShell/);
    assert.match(message, /same elevated context and SASH_HOME.*private/);
    assert.match(message, /Core-only restart.*cannot elevate/);
    assert.match(message, /already elevated.*inspect the Core error log/);
  });
  it("does not diagnose an unverified observation as a privilege failure", () => {
    const message = tunPrivilegeGuidance("activation-rolled-back", {
      platform: "darwin",
      root: "/tmp/Sash",
      observation: "unverified",
    });
    assert.match(message, /does not establish a privilege failure/);
    assert.match(message, /controller connectivity/);
    assert.match(message, /restart.*Then enable TUN again in the dashboard/);
    assert.doesNotMatch(message, /sash config set|chmod|chown/);
  });
});
