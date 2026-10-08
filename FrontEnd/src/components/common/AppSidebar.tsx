import { BookOpen, ChevronsUpDown, Monitor, Moon, SquarePen, Sun, type LucideIcon } from "lucide-react";
import { Link, useLocation } from "react-router";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTheme } from "@/app/theme";
import type { ThemePreference } from "@/features/ui/uiSlice";

const NAV: Array<{ to: string; label: string; icon: LucideIcon; match: (path: string) => boolean }> = [
  { to: "/admin/knowledge", label: "Knowledge base", icon: BookOpen, match: (p) => p.startsWith("/admin") },
];

const THEMES: Array<{ value: ThemePreference; label: string; icon: LucideIcon }> = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

export function AppSidebar() {
  const { pathname } = useLocation();
  const { isMobile, setOpenMobile } = useSidebar();
  const { theme, setTheme } = useTheme();
  const closeOnMobile = () => {
    if (isMobile) setOpenMobile(false);
  };
  const ActiveThemeIcon = THEMES.find((t) => t.value === theme)?.icon ?? Monitor;

  return (
    <Sidebar>
      <SidebarHeader className="gap-3 p-3">
        <Link to="/" onClick={closeOnMobile} className="flex flex-col items-center">
          <img src="/drig_logo.png" alt="" className="object-contain h-20" />
          <span className="text-base font-semibold tracking-tight">DRIG Support</span>
        </Link>

        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="lg" className="text-base font-medium">
              <Link to="/" onClick={closeOnMobile}>
                <SquarePen className="size-5" aria-hidden />
                New chat
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV.map(({ to, label, icon: Icon, match }) => (
                <SidebarMenuItem key={to}>
                  <SidebarMenuButton asChild isActive={match(pathname)} className="h-10 text-base">
                    <Link to={to} onClick={closeOnMobile}>
                      <Icon className="size-5" aria-hidden />
                      {label}
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="p-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" className="h-11 text-base">
              <ActiveThemeIcon className="size-5" aria-hidden />
              <span>Appearance</span>
              <ChevronsUpDown className="ml-auto size-4 opacity-60" aria-hidden />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-56">
            {THEMES.map(({ value, label, icon: Icon }) => (
              <DropdownMenuItem
                key={value}
                onSelect={() => setTheme(value)}
                className="text-base"
                data-active={theme === value}
              >
                <Icon className="size-4" aria-hidden />
                {label}
                {theme === value ? <span className="text-muted-foreground ml-auto text-xs">Active</span> : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
