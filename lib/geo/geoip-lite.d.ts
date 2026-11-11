// Minimal types for the part of geoip-lite we use (the package ships no types).
declare module "geoip-lite" {
  interface Lookup {
    country: string;
  }
  const geoip: { lookup(ip: string): Lookup | null };
  export default geoip;
}
