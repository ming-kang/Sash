import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import { describe, it } from "node:test";
import { useDaemonTestHarness } from "./daemon-test-harness.test.js";
import type { SubscriptionFetch } from "./mihomo-config.js";
import { loadProfiles, NEVER_UPDATED, type ProfileMeta, saveProfiles } from "./profiles.js";

describe("daemon server", () => {
  const h = useDaemonTestHarness();

  describe("/sash/profiles API", () => {
    const subUrl = "https://good.test/sub";
    const subYaml = "proxies:\n  - name: node-a\n    type: direct\nrules:\n  - MATCH,DIRECT\n";

    function mockFetchProfile(url: string): Promise<SubscriptionFetch> {
      if (url.includes("bad")) return Promise.reject(new Error("boom"));
      return Promise.resolve({
        doc: { proxies: [{ name: "node-a", type: "direct" }], rules: ["MATCH,DIRECT"] },
        yamlText: subYaml,
        name: "mock-sub",
        subInfo: { upload: 1, download: 2, total: 100 },
      });
    }

    it("reads an incomplete profile request body before entering the mutation lock", async () => {
      await h.startServer({ fetchProfile: mockFetchProfile });
      const body = JSON.stringify({ url: subUrl });
      const socket = net.createConnection({ host: "127.0.0.1", port: h.boundPort });
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      socket.write(
        `POST /sash/profiles HTTP/1.1\r\nHost: 127.0.0.1:${h.boundPort}\r\nAuthorization: Bearer ${h.settings.daemonSecret}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body.slice(0, 5)}`,
      );

      const stop = await h.apiRequest("/sash/core/stop", { method: "POST" });
      assert.equal(stop.statusCode, 204);
      socket.destroy();
    });

    it("allows runtime mutations while a profile fetch is still preparing", async () => {
      let releaseFetch: (() => void) | undefined;
      let fetchStartedResolve: (() => void) | undefined;
      const fetchStarted = new Promise<void>((resolve) => {
        fetchStartedResolve = resolve;
      });
      await h.startServer({
        fetchProfile: async () => {
          fetchStartedResolve?.();
          await new Promise<void>((resolve) => {
            releaseFetch = resolve;
          });
          return mockFetchProfile(subUrl);
        },
      });

      const pendingProfile = h.apiRequest("/sash/profiles", {
        method: "POST",
        body: { url: subUrl },
      });
      await fetchStarted;
      const stop = await h.apiRequest("/sash/core/stop", { method: "POST" });
      assert.equal(stop.statusCode, 204);
      releaseFetch?.();
      assert.equal((await pendingProfile).statusCode, 200);
    });

    it("starts empty", async () => {
      await h.startServer();
      const res = await h.apiRequest("/sash/profiles");
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.data, { activeId: null, profiles: [] });
    });

    it("POST downloads, auto-activates the first profile and stores metadata", async () => {
      await h.startServer({ fetchProfile: mockFetchProfile });
      const res = await h.apiRequest("/sash/profiles", { method: "POST", body: { url: subUrl } });
      assert.equal(res.statusCode, 200);
      const data = res.data as {
        profile: { id: string; name: string; url: string };
        activated: boolean;
        proxyCount: number;
      };
      assert.equal(data.activated, true);
      assert.equal(data.profile.name, "mock-sub");
      assert.equal(data.proxyCount, 1);

      const list = (await h.apiRequest("/sash/profiles")).data as {
        activeId: string;
        profiles: Array<{ id: string; subInfo?: { total: number } }>;
      };
      assert.equal(list.profiles.length, 1);
      assert.equal(list.activeId, data.profile.id);
      assert.equal(list.profiles[0]?.subInfo?.total, 100);

      assert.ok(fs.readFileSync(h.layout.configFile, "utf8").includes("node-a"));
      const statusAfterAdd = (await h.apiRequest("/sash/daemon/status")).data as {
        revisions: { profiles: number };
      };
      assert.equal(statusAfterAdd.revisions.profiles, 1);

      // Re-downloading the same URL updates in place instead of duplicating.
      const again = await h.apiRequest("/sash/profiles", { method: "POST", body: { url: subUrl } });
      assert.equal(again.statusCode, 200);
      const list2 = (await h.apiRequest("/sash/profiles")).data as { profiles: unknown[] };
      assert.equal(list2.profiles.length, 1);
      const statusAfterUpdate = (await h.apiRequest("/sash/daemon/status")).data as {
        revisions: { profiles: number };
      };
      assert.equal(statusAfterUpdate.revisions.profiles, 2);
    });

    it("a second download does not steal the active selection", async () => {
      await h.startServer({ fetchProfile: mockFetchProfile });
      const first = (
        await h.apiRequest("/sash/profiles", { method: "POST", body: { url: subUrl } })
      ).data as { profile: { id: string } };
      const second = await h.apiRequest("/sash/profiles", {
        method: "POST",
        body: { url: "https://good.test/other" },
      });
      assert.equal((second.data as { activated: boolean }).activated, false);
      const list = (await h.apiRequest("/sash/profiles")).data as {
        activeId: string;
        profiles: unknown[];
      };
      assert.equal(list.profiles.length, 2);
      assert.equal(list.activeId, first.profile.id);
    });

    it("PUT /sash/profiles/active switches and recompiles; unknown id 404s", async () => {
      await h.startServer({ fetchProfile: mockFetchProfile });
      await h.apiRequest("/sash/profiles", { method: "POST", body: { url: subUrl } });
      const second = (
        await h.apiRequest("/sash/profiles", {
          method: "POST",
          body: { url: "https://good.test/other" },
        })
      ).data as { profile: { id: string } };

      const sel = await h.apiRequest("/sash/profiles/active", {
        method: "PUT",
        body: { id: second.profile.id },
      });
      assert.equal(sel.statusCode, 200);
      assert.equal((sel.data as { activeId: string }).activeId, second.profile.id);

      const missing = await h.apiRequest("/sash/profiles/active", {
        method: "PUT",
        body: { id: "1234567890123" },
      });
      assert.equal(missing.statusCode, 404);

      // Deselect reverts to the DIRECT-only default config.
      const off = await h.apiRequest("/sash/profiles/active", {
        method: "PUT",
        body: { id: null },
      });
      assert.equal(off.statusCode, 200);
      assert.ok(!fs.readFileSync(h.layout.configFile, "utf8").includes("node-a"));
    });

    it("import validates content; local profiles cannot be URL-updated", async () => {
      await h.startServer({ fetchProfile: mockFetchProfile });
      const bad = await h.apiRequest("/sash/profiles/import", {
        method: "POST",
        body: { name: "junk", content: "not: a clash config" },
      });
      assert.equal(bad.statusCode, 400);

      const good = await h.apiRequest("/sash/profiles/import", {
        method: "POST",
        body: { name: "local", content: subYaml },
      });
      assert.equal(good.statusCode, 200);
      const imported = (good.data as { profile: { id: string; url: string } }).profile;
      assert.equal(imported.url, "");

      const upd = await h.apiRequest(`/sash/profiles/${imported.id}/update`, { method: "POST" });
      assert.equal(upd.statusCode, 400);

      const missing = await h.apiRequest("/sash/profiles/1234567890123/update", { method: "POST" });
      assert.equal(missing.statusCode, 404);
    });

    it("reads and writes profile content, rejecting invalid YAML on write", async () => {
      await h.startServer({ fetchProfile: mockFetchProfile });
      const created = (
        await h.apiRequest("/sash/profiles", { method: "POST", body: { url: subUrl } })
      ).data as { profile: { id: string } };
      const id = created.profile.id;

      const read = await h.apiRequest(`/sash/profiles/${id}/content`);
      assert.equal(read.statusCode, 200);
      const readData = read.data as { name: string; content: string };
      assert.equal(readData.content, subYaml);

      const invalid = await h.apiRequest(`/sash/profiles/${id}/content`, {
        method: "PUT",
        body: { content: "not: a clash config" },
      });
      assert.equal(invalid.statusCode, 400);

      const nextYaml = subYaml.replace("node-a", "node-b");
      const write = await h.apiRequest(`/sash/profiles/${id}/content`, {
        method: "PUT",
        body: { content: nextYaml },
      });
      assert.equal(write.statusCode, 200);
      assert.equal(fs.readFileSync(`${h.layout.profilesDir}/${id}.yaml`, "utf8"), nextYaml);

      const missing = await h.apiRequest("/sash/profiles/1234567890123/content");
      assert.equal(missing.statusCode, 404);
    });

    it("PATCH renames a profile, rejecting empty names", async () => {
      await h.startServer({ fetchProfile: mockFetchProfile });
      const created = (
        await h.apiRequest("/sash/profiles", { method: "POST", body: { url: subUrl } })
      ).data as { profile: { id: string } };
      const id = created.profile.id;

      const empty = await h.apiRequest(`/sash/profiles/${id}`, {
        method: "PATCH",
        body: { name: "  " },
      });
      assert.equal(empty.statusCode, 400);

      const renamed = await h.apiRequest(`/sash/profiles/${id}`, {
        method: "PATCH",
        body: { name: "my subscription" },
      });
      assert.equal(renamed.statusCode, 200);
      assert.equal((renamed.data as { profile: { name: string } }).profile.name, "my subscription");

      const list = (await h.apiRequest("/sash/profiles")).data as {
        profiles: Array<{ name: string }>;
      };
      assert.equal(list.profiles[0]?.name, "my subscription");

      const missing = await h.apiRequest("/sash/profiles/1234567890123", {
        method: "PATCH",
        body: { name: "ghost" },
      });
      assert.equal(missing.statusCode, 404);
    });

    it("update-all reports per-profile failures and keeps the active one hot", async () => {
      await h.startServer({ fetchProfile: mockFetchProfile });
      await h.apiRequest("/sash/profiles", { method: "POST", body: { url: subUrl } });
      // Seed a remote profile without fetching (meta-only, content pending).
      const index = loadProfiles(h.layout);
      const bad: ProfileMeta = {
        id: "9999999999999",
        name: "bad",
        url: "https://bad.test/x",
        intervalHours: 24,
        createdAt: new Date().toISOString(),
        updatedAt: NEVER_UPDATED,
      };
      saveProfiles({ ...index, profiles: [...index.profiles, bad] }, h.layout);

      const res = await h.apiRequest("/sash/profiles/update-all", { method: "POST" });
      assert.equal(res.statusCode, 200);
      const data = res.data as {
        updated: number;
        failed: Array<{ name: string; error: string }>;
        proxyCount?: number;
      };
      assert.equal(data.updated, 1);
      assert.equal(data.failed.length, 1);
      assert.equal(data.failed[0]?.error, "boom");
      // Active profile updated → recompiled even without a running core.
      assert.equal(data.proxyCount, 1);

      const list = (await h.apiRequest("/sash/profiles")).data as {
        profiles: Array<{ name: string; url: string; lastError?: string }>;
      };
      const badProfile = list.profiles.find((p) => p.url === "https://bad.test/x");
      assert.equal(badProfile?.lastError, "boom");
    });

    it("DELETE removes the file and deselects when active", async () => {
      await h.startServer({ fetchProfile: mockFetchProfile });
      const created = (
        await h.apiRequest("/sash/profiles", { method: "POST", body: { url: subUrl } })
      ).data as { profile: { id: string } };

      const del = await h.apiRequest(`/sash/profiles/${created.profile.id}`, { method: "DELETE" });
      assert.equal(del.statusCode, 200);
      assert.equal((del.data as { wasActive: boolean }).wasActive, true);

      const list = (await h.apiRequest("/sash/profiles")).data as {
        activeId: string | null;
        profiles: unknown[];
      };
      assert.equal(list.activeId, null);
      assert.equal(list.profiles.length, 0);
      assert.equal(fs.existsSync(`${h.layout.profilesDir}/${created.profile.id}.yaml`), false);

      const missing = await h.apiRequest("/sash/profiles/1234567890123", { method: "DELETE" });
      assert.equal(missing.statusCode, 404);
    });
  });
});
