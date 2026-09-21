# Intro
Pretty simple app for viewing proxmox packages changelog for their smaller releases they don't publish anywhere except APT repos.

# How it works
1) App fetches Releases.gz from http://download.proxmox.com (standard debian apt format) for several repos, along with binary-${ARCH}/ page listing to get release dates
2) Arranges them all in webui - with sorting by release date or name, with optional squash mode that removes dupes from list
3) Compares packages and then fetches their changelogs from https://metadata.cdn.proxmox.com/ when clicked on entry in webui (proxmox have them on separate cdn for some reason)
4) Shows you complete changelog for that package, provided it exists on proxmox side (some packages lack them)

Changelog files are only pulled on-demand and cached on backend to not hit proxmox's cdn too often (Even if it still fetches only releases and changelogs - tiny files)

App serves backend for fetching data and frontend for user. Cache is kept in memory - nothing to backup or maintain, app is completely stateless.

# Supported proxmox products

1) Proxmox VE
2) Proxmox Ceph (tentacle)
3) Proxmox Backup Server
4) Proxmox Backup Server (Client)
5) Proxmox Datacenter Manager
6) Proxmox Mail Gateway

It supports only no-sub and test repos. 
Only active repos too - oldest being bookworm for PVE, for example. Archived repos are not supported.
I do not have access to enterprise repo, so i can't implement it even as an optional toggle. Changelogs for pve-enterprise are available freely on metadata cdn, but without ability to list pve-enterprise packages i can't implement it without scraping everything.

# Deployment

App supports two modes - cloudflare workers (what you will see on project link - running on free plan so might get ratelimited) or docker.

For wrangler/cloudflare release look at corresponding github action and wrangler.toml file.

For docker, you can use following compose sample (docker image is hosted on GHCR, both amd64 and arm64 builds):

```
services:
  pve-changelog-web:
    image: ghcr.io/rlex/pve-changelog-web:latest
    container_name: pve-changelog-web_pve-changelog-web
    restart: unless-stopped
    ports:
      - 8080:8080
```