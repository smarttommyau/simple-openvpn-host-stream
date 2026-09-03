# simple-openvpn-host-stream

Host region-locked streams using an OpenVPN configuration and stream them to a self-hosted site, which you can watch on other devices without setting up VPN there.

## Features

- **Region-Free Streaming**: Access geo-restricted content by routing traffic through a VPN server configured within the container 
- **Setup with OpenVPN**: Use your own OpenVPN configuration files to connect to a VPN server
- **Streaming with streamlink**: Fetch streams from supported sites and convert them to HLS format for easy playback
- **EPG Integration**: Built-in Electronic Program Guide for browsing available channels and their schedules
- **Channel Switcher**: Seamless channel switching with using the EPG interface
- **Docker-Based Deployment**: Easy deployment using Docker Compose

## Setup Instructions

### Prerequisites

- Docker and Docker Compose installed on your host system
- Access to a VPN server configuration (OpenVPN config files)
- EPG XML source URL (Optional, for channel guide functionality)

### Quick Start with Docker

1. **Configure Environment Variables**

   Copy the example environment file and configure your settings:

   ```bash
   cp .env.example .env
   ```

   Edit `.env` and set the following variables:

   - `PORT`: Port to expose (default: 8080)
   - `STREAM_URL`: The target streaming site URL (Check [streamlink supported sites](https://streamlink.github.io/plugins.html))

2. **Prepare OpenVPN Configuration**

   Place your OpenVPN configuration file(.ovpn) in the `openvpn-config/` directory:

3. **Build and Run**

   ```bash
   docker-compose up -d --build
   ```

4. **Access the Application**

   Open your browser and navigate to:

   ```
   http://localhost:8080
   ```

## Configuration

### Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `PORT` | Web server port to expose (default: 8080) | 8080 | No |
| `STREAM_URL` | Target streaming site URL (e.g., YouTube, Twitch, HLS stream) | - | Yes |
| `TZ` | Timezone for containers and EPG data | Asia/Hong_Kong | No |
| `OPENVPN_CONFIG_PATH` | Path to OpenVPN configuration file (relative to project root) | ./openvpn-config/openvpn.ovpn | No |
| `ENABLE_EPG` | Enable/disable EPG functionality | false | No |
| `EPG_LINK` | URL to EPG XML source for channel guide data | https://example.com/epg.xml | No (if ENABLE_EPG=true) |
| `EPG_BASE_STREAM_URL` | Base stream URL prefix for channels with non-full URLs in EPG | - | No (if ENABLE_EPG=true) |
| `TIMEOUT_SECONDS` | Stream timeout in seconds before automatic restart | 30 | No |



## Channel Switcher & EPG

- Real-time Electronic Program Guide (EPG) data
- Channel browsing and search functionality
- Visual program schedule display
- Switching using a FAB button

> built using the [dbghelp/html-epg-viewer](https://github.com/dbghelp/html-epg-viewer)

### Setup epg

1. Obtain an EPG XML source URL (e.g., from your IPTV provider or online sources)
2. Update the `EPG_URL` variable in the `.env` file with your EPG XML source URL
3. Check the id of the channels in the xml, if they are not full URL, you need to add the base URL in the `EPG_BASE_STREAM_URL` variable in the `.env` file.

## License

See [LICENSE](LICENSE) file for details.

## Contributing

Contributions are welcome! Please feel free to submit pull requests or open issues for bugs and feature requests.

## Acknowledgments

- **EPG Viewer Library**: Special thanks to [dbghelp/html-epg-viewer](https://github.com/dbghelp/html-epg-viewer) for providing the EPG viewer component used in this project.
- **Docker Images**: Using `ghcr.io/utkuozdemir/dperson-openvpn-client` for OpenVPN containerization.
- **Streamlink**: Leveraging [streamlink](https://streamlink.github.io/) for fetching and streaming content from supported sites.
- **ffmpeg**: Utilizing [ffmpeg](https://ffmpeg.org/) for media processing and conversion to HLS format.

## Support

For issues, questions, or contributions, please open an issue on the repository.
