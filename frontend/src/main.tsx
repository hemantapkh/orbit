import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import "./index.css";
import { RequireOperator } from "./app/auth";
import { ErrorBoundary, NotFound } from "./app/errors";
import { Shell } from "./app/Shell";
import { BotDetailPage } from "./features/bots/BotDetailPage";
import { PeoplePage } from "./features/people/PeoplePage";
import { BotsPage } from "./features/bots/BotsPage";
import { CampaignDetailPage } from "./features/campaigns/CampaignDetailPage";
import { CampaignEditorPage } from "./features/campaigns/CampaignEditorPage";
import { CampaignsPage } from "./features/campaigns/CampaignsPage";
import { SharePage } from "./features/campaigns/SharePage";
import { TestGroupsPage } from "./features/campaigns/TestGroupsPage";
import { InvitePage } from "./features/settings/InvitePage";
import { SettingsPage } from "./features/settings/SettingsPage";
import { OverviewPage } from "./features/overview/OverviewPage";

// Charts are heavy; load analytics only when someone opens it.
const AnalyticsPage = lazy(() => import("./features/analytics/AnalyticsPage").then((m) => ({ default: m.AnalyticsPage })));

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: true } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ErrorBoundary>
          <Routes>
          {/* Public, read-only: the token in the URL is the credential. */}
          <Route path="/share/:token" element={<SharePage />} />
          <Route path="/invite/:token" element={<InvitePage />} />
          <Route
            path="/*"
            element={
              <RequireOperator>
                <OperatorRoutes />
              </RequireOperator>
            }
          />
          </Routes>
        </ErrorBoundary>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);

function OperatorRoutes() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<OverviewPage />} />
        <Route path="bots" element={<BotsPage />} />
        <Route path="bots/:botId" element={<BotDetailPage />} />
        <Route path="people" element={<PeoplePage />} />
        <Route path="broadcasts" element={<CampaignsPage />} />
        <Route path="broadcasts/new" element={<CampaignEditorPage />} />
        <Route path="broadcasts/test-groups" element={<TestGroupsPage />} />
        <Route path="broadcasts/:campaignId" element={<CampaignDetailPage />} />
        <Route path="broadcasts/:campaignId/edit" element={<CampaignEditorPage />} />
        <Route
          path="analytics"
          element={
            <Suspense fallback={<div className="h-96 animate-pulse rounded-xl bg-line/50" />}>
              <AnalyticsPage />
            </Suspense>
          }
        />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
