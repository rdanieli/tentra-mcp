import { readdir, readFile, stat } from 'fs/promises'
import { join, basename, relative, dirname } from 'path'
import { DetectedService, DetectedConnection, AnalysisResult } from './types.js'
import { detectFromPackageJson } from './detectors/node.js'
import { detectFromDockerCompose } from './detectors/docker.js'
import { detectFromPomXml, detectFromApplicationConfig } from './detectors/java.js'
import { detectFromGoMod } from './detectors/go.js'
import { detectFromPython } from './detectors/python.js'
import { detectFromKubernetesManifest, isKubernetesManifest } from './detectors/kubernetes.js'
import { detectFromTerraform } from './detectors/terraform.js'
import { inferConnections } from './connections.js'

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '__pycache__',
  '.venv', 'venv', 'target', 'vendor', '.gradle', '.idea', '.vscode',
  'coverage', '.cache', '.turbo', '.pnpm'
])

// Directories that typically contain Kubernetes manifests
const K8S_DIRS = new Set(['k8s', 'kubernetes', 'manifests', 'deploy', 'deployments', 'helm', 'charts'])

// File names that are likely Kubernetes manifests
const K8S_FILE_NAMES = new Set([
  'deployment.yml', 'deployment.yaml',
  'service.yml', 'service.yaml',
  'ingress.yml', 'ingress.yaml',
  'statefulset.yml', 'statefulset.yaml',
  'daemonset.yml', 'daemonset.yaml',
  'cronjob.yml', 'cronjob.yaml',
  'configmap.yml', 'configmap.yaml',
  'hpa.yml', 'hpa.yaml',
])

const MAX_DEPTH = 6

export async function scanCodebase(rootPath: string): Promise<AnalysisResult> {
  const services: DetectedService[] = []
  const allConnections: DetectedConnection[] = []
  const configFiles: Map<string, string> = new Map()

  // Phase 1: Walk the tree and collect config files
  await walkDirectory(rootPath, rootPath, 0, configFiles)

  // Phase 2: Detect services from docker-compose (highest priority — defines the system shape)
  for (const [path, content] of configFiles) {
    if (basename(path).match(/^docker-compose.*\.ya?ml$/)) {
      const detected = detectFromDockerCompose(content, path, rootPath)
      services.push(...detected)
    }
  }

  // Phase 3: Detect from language-specific config files
  const existingIds = new Set(services.map(s => s.id))

  for (const [path, content] of configFiles) {
    const name = basename(path)
    let detected: DetectedService[] = []

    if (name === 'package.json') {
      detected = detectFromPackageJson(content, path, rootPath)
    } else if (name === 'pom.xml') {
      detected = detectFromPomXml(content, path, rootPath)
    } else if (name === 'go.mod') {
      detected = detectFromGoMod(content, path, rootPath)
    } else if (name === 'pyproject.toml' || name === 'requirements.txt') {
      detected = detectFromPython(content, path, rootPath, name)
    } else if (name === 'application.yml' || name === 'application.yaml' || name === 'application.properties') {
      detected = detectFromApplicationConfig(content, path, rootPath)
    }

    // Only add if not already detected from docker-compose
    for (const svc of detected) {
      if (!existingIds.has(svc.id)) {
        services.push(svc)
        existingIds.add(svc.id)
      }
    }
  }

  // Phase 3b: Detect from Kubernetes manifests
  for (const [path, content] of configFiles) {
    const name = basename(path)
    if ((name.endsWith('.yml') || name.endsWith('.yaml')) && isKubernetesManifest(content)) {
      const result = detectFromKubernetesManifest(content, path, rootPath)
      for (const svc of result.services) {
        if (!existingIds.has(svc.id)) {
          services.push(svc)
          existingIds.add(svc.id)
        }
      }
      allConnections.push(...result.connections)
    }
  }

  // Phase 3c: Detect from Terraform files
  for (const [path, content] of configFiles) {
    if (path.endsWith('.tf')) {
      const result = detectFromTerraform(content, path, rootPath)
      for (const svc of result.services) {
        if (!existingIds.has(svc.id)) {
          services.push(svc)
          existingIds.add(svc.id)
        }
      }
      allConnections.push(...result.connections)
    }
  }

  // Phase 4: Infer connections
  const inferredConnections = await inferConnections(services, configFiles, rootPath)
  allConnections.push(...inferredConnections)

  // Phase 5: Deduplicate and clean
  const cleanServices = deduplicateServices(services)
  const cleanConnections = deduplicateConnections(allConnections, cleanServices)

  return {
    services: cleanServices,
    connections: cleanConnections,
    metadata: {
      rootPath,
      scannedFiles: configFiles.size,
      detectedServices: cleanServices.length,
      detectedConnections: cleanConnections.length
    }
  }
}

async function walkDirectory(
  dir: string,
  rootPath: string,
  depth: number,
  configFiles: Map<string, string>
): Promise<void> {
  if (depth > MAX_DEPTH) return

  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  const dirName = basename(dir)
  const isK8sDir = K8S_DIRS.has(dirName)

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)

    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      await walkDirectory(fullPath, rootPath, depth + 1, configFiles)
    } else if (entry.isFile()) {
      if (isConfigFile(entry.name, isK8sDir)) {
        try {
          const content = await readFile(fullPath, 'utf-8')
          configFiles.set(fullPath, content)
        } catch {
          // Skip unreadable files
        }
      }
    }
  }
}

function isConfigFile(name: string, inK8sDir: boolean = false): boolean {
  // Standard config files
  if (
    name === 'package.json' ||
    name === 'pom.xml' ||
    name === 'build.gradle' ||
    name === 'build.gradle.kts' ||
    name === 'go.mod' ||
    name === 'pyproject.toml' ||
    name === 'requirements.txt' ||
    name === 'Dockerfile' ||
    name === '.env' ||
    name === '.env.example' ||
    name === 'application.yml' ||
    name === 'application.yaml' ||
    name === 'application.properties' ||
    name.match(/^docker-compose.*\.ya?ml$/) !== null ||
    name.match(/^\.env/) !== null ||
    name === 'prisma/schema.prisma' ||
    name === 'schema.prisma'
  ) {
    return true
  }

  // Terraform files
  if (name.endsWith('.tf')) {
    return true
  }

  // Kubernetes manifest files — pick up YAML in known k8s directories
  if (inK8sDir && (name.endsWith('.yml') || name.endsWith('.yaml'))) {
    return true
  }

  // Well-known Kubernetes file names anywhere
  if (K8S_FILE_NAMES.has(name)) {
    return true
  }

  return false
}

function deduplicateServices(services: DetectedService[]): DetectedService[] {
  const seen = new Map<string, DetectedService>()
  for (const svc of services) {
    const existing = seen.get(svc.id)
    if (!existing || svc.confidence > existing.confidence) {
      seen.set(svc.id, svc)
    }
  }
  return Array.from(seen.values())
}

function deduplicateConnections(
  connections: DetectedConnection[],
  services: DetectedService[]
): DetectedConnection[] {
  const serviceIds = new Set(services.map(s => s.id))
  const seen = new Set<string>()
  const result: DetectedConnection[] = []

  for (const conn of connections) {
    // Only keep connections where both endpoints exist
    if (!serviceIds.has(conn.from) || !serviceIds.has(conn.to)) continue
    // No self-connections
    if (conn.from === conn.to) continue

    const key = `${conn.from}->${conn.to}:${conn.type}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(conn)
  }

  return result
}
