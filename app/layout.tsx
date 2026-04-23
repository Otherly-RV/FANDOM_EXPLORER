import "./globals.css";

export const metadata = {
  title: "Fandom Explorer",
  description: "Explore and replicate the real structure of any Fandom wiki",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
