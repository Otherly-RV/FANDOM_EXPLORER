import "./globals.css";

export const metadata = {
  title: "Fandom Explorer",
  description: "Explore and replicate the real structure of any Fandom wiki",
};

export const viewport = {
  colorScheme: "light" as const,
  themeColor: "#ffffff",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" style={{ colorScheme: "light", background: "#ffffff" }}>
      <head>
        <meta name="color-scheme" content="light only" />
      </head>
      <body style={{ background: "#ffffff", colorScheme: "light" }}>{children}</body>
    </html>
  );
}
