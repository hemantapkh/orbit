import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import "./index.css";
import { RequireOperator } from "./app/auth";
import { ErrorBoundary, NotFound } from "./app/errors";
import { Shell } from "./app/Shell";
import { BotDetailPage } from "./features/bots/BotDetailPage";
import { BotsPage } from "./features/bots/BotsPage";
import { CampaignDetailPage } from "./features/campaigns/CampaignDetailPage";
import { CampaignEditorPage } from "./features/campaigns/CampaignEditorPage";
import { CampaignsPage } from "./features/campaigns/CampaignsPage";
import { OverviewPage } from "./features/overview/OverviewPage";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: true } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ErrorBoundary>
        <RequireOperator>
          <Routes>
            <Route element={<Shell />}>
              <Route index element={<OverviewPage />} />
              <Route path="bots" element={<BotsPage />} />
              <Route path="bots/:botId" element={<BotDetailPage />} />
              <Route path="broadcasts" element={<CampaignsPage />} />
              <Route path="broadcasts/new" element={<CampaignEditorPage />} />
              <Route path="broadcasts/:campaignId" element={<CampaignDetailPage />} />
              <Route path="broadcasts/:campaignId/edit" element={<CampaignEditorPage />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </RequireOperator>
        </ErrorBoundary>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
