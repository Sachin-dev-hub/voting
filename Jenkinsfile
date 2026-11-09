// Docker Hub repo (single repo — services are distinguished by tag suffix)
def SERVICES = ['backend', 'frontend', 'voter-simulator']

pipeline {
    agent any

    environment {
        REGISTRY       = 'sachinmaskar/voting'     // Docker Hub repository
        TRIVY_SEVERITY = 'CRITICAL,HIGH'
        // NOTE: IMAGE_TAG is NOT set here. The global environment block is
        // evaluated before stages run, when GIT_COMMIT is not yet populated.
        // It is computed in the Docker Build stage (after checkout) → env.IMAGE_TAG.
    }

    stages {

        stage('Checkout') {
            steps {
                echo 'Checking out GitHub repository'

                git branch: 'main',
                    url: 'https://github.com/Sachin-dev-hub/voting.git'
            }
        }

        stage('Check SonarScanner') {
            steps {
                script {
                    def scannerHome = tool 'SonarScanner'

                    echo "SonarScanner location: ${scannerHome}"

                    sh "${scannerHome}/bin/sonar-scanner --version"
                }
            }
        }

        stage('SonarQube Analysis') {
            steps {
                script {
                    def scannerHome = tool 'SonarScanner'

                    withSonarQubeEnv('SonarQube') {
                        sh """
                            ${scannerHome}/bin/sonar-scanner \
                            -Dsonar.projectKey=my-first-project \
                            -Dsonar.projectName=my-first-project \
                            -Dsonar.sources=.
                        """
                    }
                }
            }
        }

        stage('Docker Build') {
            steps {
                script {
                    // Set the immutable tag once, after checkout (GIT_COMMIT exists here).
                    env.IMAGE_TAG = (env.GIT_COMMIT ?: 'latest').take(8)

                    SERVICES.each { svc ->
                        sh "docker build -t ${env.REGISTRY}:${svc}-${env.IMAGE_TAG} -t ${env.REGISTRY}:${svc} ./${svc}"
                    }
                }
            }
        }

        stage('Trivy Scan') {
            steps {
                script {
                    // Trivy client/server: the server (vuln DB) runs on a separate
                    // Azure VM. TRIVY_SERVER_URL and TRIVY_TOKEN are set once under
                    // Jenkins → Manage Jenkins → System → Global properties.
                    def trivyServer = env.TRIVY_SERVER_URL ?: ''
                    if (!trivyServer) {
                        error "TRIVY_SERVER_URL is not set. Add it to Global properties, e.g. http://<azure-vm-public-ip>:8082"
                    }
                    def tokenFlag = env.TRIVY_TOKEN ? "--token ${env.TRIVY_TOKEN}" : ''

                    SERVICES.each { svc ->
                        sh """
                            docker run --rm \
                              -v /var/run/docker.sock:/var/run/docker.sock \
                              aquasec/trivy:latest \
                              client --remote ${trivyServer} ${tokenFlag} \
                              image --severity ${env.TRIVY_SEVERITY} --ignore-unfixed --exit-code 1 \
                              ${env.REGISTRY}:${svc}-${env.IMAGE_TAG}
                        """
                    }
                }
            }
        }

        stage('Docker Push') {
            steps {
                withCredentials([usernamePassword(
                    credentialsId: 'dockerhub',
                    usernameVariable: 'DOCKER_USER',
                    passwordVariable: 'DOCKER_PASS'
                )]) {
                    sh 'echo "$DOCKER_PASS" | docker login -u "$DOCKER_USER" --password-stdin'
                    script {
                        SERVICES.each { svc ->
                            sh "docker push ${env.REGISTRY}:${svc}-${env.IMAGE_TAG}"
                            sh "docker push ${env.REGISTRY}:${svc}"
                        }
                    }
                }
            }
        }
    }
}
