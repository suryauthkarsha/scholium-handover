import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import { BrowserRouter, Link, Route, Routes } from "react-router-dom";

import Shell, { Page } from "@/components/Shell";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuth } from "@/hooks/useAuth";
import { ApiError } from "@/lib/api";

import NewRun from "./pages/NewRun";
import Projects from "./pages/Projects";
import RunPage from "./pages/RunPage";
import Settings from "./pages/Settings";
import SignIn, { AuthCallback } from "./pages/SignIn";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A refusal is an answer, not a glitch: only network and server faults are retried.
      retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
      refetchOnWindowFocus: true,
    },
  },
});

/** Nothing of the workspace is rendered, fetched or kept unless the server has accepted this session. */
function Gate() {
  const { access, isLoading } = useAuth();
  const allowed = !isLoading && access.state === "allowed";
  useEffect(() => {
    if (!allowed) queryClient.clear();
  }, [allowed]);
  return allowed ? <Shell /> : <SignIn />;
}

function NotFound() {
  return (
    <Page eyebrow="Nothing here" title="This page does not exist">
      <p className="text-muted-foreground">
        The address may be mistyped, or the project may have been deleted.{" "}
        <Link to="/" className="text-rubric underline underline-offset-4">
          Back to the projects
        </Link>
      </p>
    </Page>
  );
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider delayDuration={250}>
      <Toaster position="bottom-right" />
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route element={<Gate />}>
            <Route path="/" element={<Projects />} />
            <Route path="/new" element={<NewRun />} />
            <Route path="/r/:id" element={<RunPage />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
