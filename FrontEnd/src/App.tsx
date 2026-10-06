import { RouterProvider } from "react-router";
import { Providers } from "@/app/providers";
import { router } from "@/app/router";

export default function App() {
  console.log('test');
  
  return (
    <Providers>
      <RouterProvider router={router} />
    </Providers>
  );
}
