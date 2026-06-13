import { Outlet } from "react-router";
import { AppSidebar } from "~/components/app-sidebar";

// Pathless layout that wraps every in-app screen with the sidebar.
// Auth guards will live here later; for now everything is open.
export default function AppLayout() {
  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <AppSidebar />
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
