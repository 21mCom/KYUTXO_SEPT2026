// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Suspense, useEffect, useMemo, useState } from "react";
import { Route, Switch, useLocation } from "wouter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retryableLazy, RouteNavigationContent } from "./App";

function CommitReporter({ onCommit }: { onCommit: (path: string) => void }) {
  const [location] = useLocation();
  useEffect(() => onCommit(location), [location, onCommit]);
  return null;
}

function Harness({ importer }: { importer: () => Promise<{ default: () => JSX.Element }> }) {
  const [location, setLocation] = useState("/");
  const Records = useMemo(() => retryableLazy(importer), [importer]);
  return (
    <>
      <button onClick={() => setLocation("/")}>Open dashboard</button>
      <button onClick={() => setLocation("/records")}>Open records</button>
      <RouteNavigationContent
        location={location}
        navigate={setLocation}
        renderRoutes={(onCommit) => (
          <Suspense fallback={<div>Loading route</div>}>
            <Switch>
              <Route path="/">{() => <div>Current dashboard content</div>}</Route>
              <Route path="/records" component={Records} />
            </Switch>
            <CommitReporter onCommit={onCommit} />
          </Suspense>
        )}
      />
    </>
  );
}

function RaceHarness({
  recordsImporter,
  settingsImporter,
}: {
  recordsImporter: () => Promise<{ default: () => JSX.Element }>;
  settingsImporter: () => Promise<{ default: () => JSX.Element }>;
}) {
  const [location, setLocation] = useState("/");
  const Records = useMemo(() => retryableLazy(recordsImporter), [recordsImporter]);
  const Settings = useMemo(() => retryableLazy(settingsImporter), [settingsImporter]);
  return (
    <>
      <button onClick={() => setLocation("/records")}>Open records</button>
      <button onClick={() => setLocation("/settings")}>Open settings</button>
      <RouteNavigationContent
        location={location}
        navigate={setLocation}
        renderRoutes={(onCommit) => (
          <Suspense fallback={<div>Loading route</div>}>
            <Switch>
              <Route path="/">{() => <div>Current dashboard content</div>}</Route>
              <Route path="/records" component={Records} />
              <Route path="/settings" component={Settings} />
            </Switch>
            <CommitReporter onCommit={onCommit} />
          </Suspense>
        )}
      />
    </>
  );
}

describe("route navigation recovery", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("keeps the current page visible while the next page loads and after its download fails", async () => {
    let reject!: (error: Error) => void;
    const importer = vi.fn(() => new Promise<{ default: () => JSX.Element }>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    }));
    render(<Harness importer={importer} />);
    expect(await screen.findByText("Current dashboard content")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open records" }));

    expect(await screen.findByTestId("route-navigation-loading")).toBeTruthy();
    expect(screen.getByText("Current dashboard content")).toBeTruthy();

    await act(async () => {
      reject(new Error("chunk download failed"));
    });

    expect(await screen.findByTestId("route-navigation-error")).toBeTruthy();
    expect(screen.getByText("Current dashboard content")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Stay on this page" }));
    await waitFor(() => {
      expect(screen.queryByTestId("route-navigation-error")).toBeNull();
    });
    expect(screen.getByText("Current dashboard content")).toBeTruthy();
  });

  it("retries the failed navigation with a fresh download and commits it on success", async () => {
    let rejectFirst!: (error: Error) => void;
    let resolveSecond!: (module: { default: () => JSX.Element }) => void;
    const importer = vi
      .fn<() => Promise<{ default: () => JSX.Element }>>()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => {
        rejectFirst = reject;
      }))
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveSecond = resolve;
      }));

    render(<Harness importer={importer} />);
    expect(await screen.findByText("Current dashboard content")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open records" }));
    await act(async () => rejectFirst(new Error("first chunk download failed")));

    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("route-navigation-loading")).toBeTruthy();
    expect(screen.getByText("Current dashboard content")).toBeTruthy();

    await act(async () => {
      resolveSecond({ default: () => <div>Records page content</div> });
    });
    expect(await screen.findByText("Records page content")).toBeTruthy();
    expect(screen.queryByTestId("route-navigation-error")).toBeNull();
    expect(importer).toHaveBeenCalledTimes(2);
  });

  it("releases each obsolete failed attempt while keeping the successful route stable", async () => {
    const importer = vi
      .fn<() => Promise<{ default: () => JSX.Element }>>()
      .mockRejectedValueOnce(new Error("first chunk download failed"))
      .mockRejectedValueOnce(new Error("second chunk download failed"))
      .mockResolvedValue({
        default: () => <div>Stable records page content</div>,
      });

    render(<Harness importer={importer} />);
    expect(await screen.findByText("Current dashboard content")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open records" }));
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Stable records page content")).toBeTruthy();
    expect(importer).toHaveBeenCalledTimes(3);

    fireEvent.click(screen.getByRole("button", { name: "Open dashboard" }));
    expect(await screen.findByText("Current dashboard content")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open records" }));
    expect(await screen.findByText("Stable records page content")).toBeTruthy();
    expect(importer).toHaveBeenCalledTimes(3);
  });

  it("ignores a late failure from a page that is no longer the navigation target", async () => {
    let rejectRecords!: (error: Error) => void;
    let resolveSettings!: (module: { default: () => JSX.Element }) => void;
    const recordsImporter = vi.fn(() => new Promise<{ default: () => JSX.Element }>(
      (_resolve, reject) => { rejectRecords = reject; },
    ));
    const settingsImporter = vi.fn(() => new Promise<{ default: () => JSX.Element }>(
      (resolve) => { resolveSettings = resolve; },
    ));

    render(
      <RaceHarness
        recordsImporter={recordsImporter}
        settingsImporter={settingsImporter}
      />,
    );
    expect(await screen.findByText("Current dashboard content")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open records" }));
    await waitFor(() => expect(recordsImporter).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    await waitFor(() => expect(settingsImporter).toHaveBeenCalledTimes(1));

    await act(async () => rejectRecords(new Error("obsolete records download failed")));
    expect(screen.queryByTestId("route-navigation-error")).toBeNull();
    expect(screen.getByTestId("route-navigation-loading")).toBeTruthy();
    expect(screen.getByText("Current dashboard content")).toBeTruthy();

    await act(async () => {
      resolveSettings({ default: () => <div>Settings page content</div> });
    });
    expect(await screen.findByText("Settings page content")).toBeTruthy();
  });
});