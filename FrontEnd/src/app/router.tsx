import { lazy, Suspense } from "react";
import { createBrowserRouter, Navigate, type RouteObject } from "react-router";
import { SkeletonRouteFallback } from "@/components/common/SkeletonRouteFallback";

const ChatScreen = lazy(() => import("@/features/chat/ChatScreen"));
const VehicleScreen = lazy(() => import("@/features/vehicle/VehicleScreen"));
const HandoffScreen = lazy(() => import("@/features/handoff/HandoffScreen"));
const EngineerQueueScreen = lazy(
  () => import("@/features/engineer/EngineerQueueScreen"),
);
const SignInScreen = lazy(() => import("@/features/auth/SignInScreen"));
const RagSearchScreen = lazy(() => import("@/features/ragSearch/RagSearchScreen"));
const AdminKnowledgeScreen = lazy(() => import("@/features/admin/AdminKnowledgeScreen"));

function lazyRoute(element: React.ReactNode) {
  return <Suspense fallback={<SkeletonRouteFallback />}>{element}</Suspense>;
}

/** A fresh session id per cold start. Sessions are cheap; inheriting the
 *  previous job's vehicle is not (BACKEND_MEMORY.md §8). */
function NewSession() {
  return <Navigate to={`/s/${crypto.randomUUID()}`} replace />;
}

const routes: RouteObject[] = [
  { path: "/", element: <NewSession /> },
  { path: "/s/:sessionId", element: lazyRoute(<ChatScreen />) },
  { path: "/vehicle", element: lazyRoute(<VehicleScreen />) },
  { path: "/handoff", element: lazyRoute(<HandoffScreen />) },
  { path: "/engineer", element: lazyRoute(<EngineerQueueScreen />) },
  { path: "/sign-in", element: lazyRoute(<SignInScreen />) },
  { path: "/search", element: lazyRoute(<RagSearchScreen />) },
  { path: "/admin/knowledge", element: lazyRoute(<AdminKnowledgeScreen />) },
  { path: "*", element: <Navigate to="/" replace /> },
];

export const router = createBrowserRouter(routes);
