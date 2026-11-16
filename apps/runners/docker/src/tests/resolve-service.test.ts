import { describe, expect, it, vi } from "vitest";
import type Dockerode from "dockerode";
import { resolveService } from "../docker/resolve-service.js";
import { hideContainer } from "../docker/client.js";
import { listedContainer } from "./docker-fixtures.js";

// Only the two calls resolveService makes, so the rest of Dockerode is left out.
function makeDocker(containers: Dockerode.ContainerInfo[]): Dockerode {
  return {
    listContainers: vi.fn().mockResolvedValue(containers),
    getContainer: vi.fn().mockImplementation((id: string) => ({ id })),
  } as unknown as Dockerode;
}

const IDENTITY = {
  project: "shop",
  service: "postgres",
};

describe("resolveService", () => {
  it("matches a running container by Compose project/service labels", async () => {
    const docker = makeDocker([
      listedContainer({ Id: "live-1", Names: ["/shop_postgres_1"] }),
    ]);

    const resolved = await resolveService(docker, IDENTITY);

    expect(resolved).toMatchObject({
      id: "live-1",
      name: "shop_postgres_1",
      live: true,
    });
  });

  // A redeploy whose new container crashed leaves the old one serving, and the newer one stopped.
  it("prefers the live container over a newer stopped one with the same identity", async () => {
    const docker = makeDocker([
      listedContainer({ Id: "old-live", State: "running", Created: 100 }),
      listedContainer({ Id: "new-crashed", State: "exited", Created: 200 }),
    ]);

    const resolved = await resolveService(docker, IDENTITY);

    expect(resolved).toMatchObject({ id: "old-live", live: true });
  });

  it("picks the most recently created instance when two are briefly live together mid-redeploy", async () => {
    const docker = makeDocker([
      // The older one is listed FIRST: a naive "first running container wins"
      // implementation would pick this one, which is the wrong answer.
      listedContainer({ Id: "older-live", Created: 100 }),
      listedContainer({ Id: "newer-live", Created: 200 }),
    ]);

    const resolved = await resolveService(docker, IDENTITY);

    expect(resolved).toMatchObject({ id: "newer-live", live: true });
  });

  it("falls back to the most recently created stopped container when nothing is live", async () => {
    const docker = makeDocker([
      listedContainer({ Id: "older-stopped", State: "exited", Created: 100 }),
      listedContainer({ Id: "newer-stopped", State: "exited", Created: 200 }),
    ]);

    const resolved = await resolveService(docker, IDENTITY);

    expect(resolved).toMatchObject({ id: "newer-stopped", live: false });
  });

  it("falls back to a literal name match for anonymous containers with no Compose labels", async () => {
    const docker = makeDocker([
      listedContainer({ Id: "anon-1", Names: ["/redis-cache"], Labels: {} }),
    ]);

    const resolved = await resolveService(docker, {
      project: "redis-cache",
      service: "redis-cache",
    });

    expect(resolved).toMatchObject({ id: "anon-1", live: true });
  });

  it("returns null when no container matches the identity at all", async () => {
    const docker = makeDocker([
      listedContainer({ Id: "unrelated", Names: ["/nginx"], Labels: {} }),
    ]);

    const resolved = await resolveService(docker, IDENTITY);

    expect(resolved).toBeNull();
  });

  it("propagates a genuine Docker daemon failure instead of treating it as a missing service", async () => {
    const docker = {
      listContainers: vi
        .fn()
        .mockRejectedValue(new Error("connect ENOENT /var/run/docker.sock")),
      getContainer: vi.fn(),
    } as unknown as Dockerode;

    await expect(resolveService(docker, IDENTITY)).rejects.toThrow(
      "connect ENOENT /var/run/docker.sock",
    );
  });
});

describe("the control plane is not a service", () => {
  it("resolves a hidden container to nothing, like one that does not exist", async () => {
    const hiddenId = "c".repeat(64);
    hideContainer(hiddenId);

    const docker = makeDocker([listedContainer({ Id: hiddenId })]);

    // Not a refusal the agent can tell apart from a missing service: read and
    // write share this resolver, so neither can reach what it cannot enumerate.
    expect(await resolveService(docker, IDENTITY)).toBeNull();
  });
});
