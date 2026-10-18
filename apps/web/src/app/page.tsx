"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Landing } from "@/components/landing/Landing";

export default function HomePage() {
  const router = useRouter();

  useEffect(() => {
    if (typeof window !== "undefined") {
      const token = localStorage.getItem("dr_token");
      if (token) {
        const lastRoute = localStorage.getItem("memento_last_route") || "/ask";
        router.replace(lastRoute);
      }
    }
  }, [router]);

  return <Landing />;
}
