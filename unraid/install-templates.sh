#!/bin/sh
set -eu

base_url="https://raw.githubusercontent.com/Tracker-Dashboard/tracker-dashboard/main/unraid"
destination="/boot/config/plugins/dockerMan/templates-user"

if [ "$(id -u)" -ne 0 ]; then
  echo "Ce script doit être exécuté en root depuis le terminal Unraid." >&2
  exit 1
fi

mkdir -p "$destination"

for name in tracker-dashboard tracker-dashboard-browser tracker-dashboard-flaresolverr tracker-dashboard-trawl; do
  target="$destination/my-$name.xml"
  curl -fsSL "$base_url/$name.xml" -o "$target"
  echo "Template installé : $target"
done

echo
echo "Ouvrez Docker > Add Container, puis installez les trois templates dans cet ordre :"
echo "1. tracker-dashboard"
echo "2. tracker-dashboard-browser"
echo "3. tracker-dashboard-flaresolverr"
echo "4. tracker-dashboard-trawl"
