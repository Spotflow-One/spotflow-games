import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from "react-router";
import { AuthProvider, useAuth } from "./lib/auth";
import { PreferencesProvider } from "./lib/preferences";
import { Layout } from "./components/Layout";
import { Home } from "./pages/Home";
import { Me } from "./pages/Me";
import { Profile } from "./pages/Profile";
import { Session } from "./pages/Session";
import { SignIn } from "./pages/SignIn";
import "./styles/tokens.css";
import "./styles/components.css";
import "./styles/app.css";

/** Every page except sign-in needs a Spotflow account, including invitation links. */
function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  const location = useLocation();
  if (loading) return null;
  if (!me)
    return <Navigate to={`/signin?returnTo=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return children;
}

function JoinRedirect() {
  const { code } = useParams();
  return <Navigate to={`/s/${(code ?? "").toUpperCase()}`} replace />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <PreferencesProvider>
          <Routes>
            <Route path="/signin" element={<SignIn />} />
            <Route
              element={
                <RequireAuth>
                  <Layout />
                </RequireAuth>
              }
            >
              <Route index element={<Home />} />
              <Route path="/join/:code" element={<JoinRedirect />} />
              <Route path="/s/:code" element={<Session />} />
              <Route path="/me" element={<Me />} />
              <Route path="/profile/:id" element={<Profile />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </PreferencesProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
